import request from "supertest";
import { Types } from "mongoose";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { AGENTGUARD_DEMO_ACTION_ID, DEMO_WORKSPACE_SLUG, MAX_APPS_PER_WORKSPACE, MAX_BYTES_PER_WORKSPACE_TOTAL, STORAGE_GLOBAL_KEY, STORAGE_GLOBAL_WORKSPACE_ID, STORAGE_TOTAL_KEY } from "../src/constants";
import { App } from "../src/models/app.model";
import { ForkUsage } from "../src/models/forkUsage.model";
import { MaintenanceLog } from "../src/models/maintenanceLog.model";
import { Run } from "../src/models/run.model";
import { Step } from "../src/models/step.model";
import { StorageUsage } from "../src/models/storageUsage.model";
import { TestCase } from "../src/models/testCase.model";
import { TestResult } from "../src/models/testResult.model";
import { TestRunUsage } from "../src/models/testRunUsage.model";
import { Workspace } from "../src/models/workspace.model";
import { resetDemoIfDue, resetDemoWorkspace } from "../src/services/demo/demoSeed.service";
import { agentGuardLink, DEMO_TESTS, WRONG_RUN_ID } from "../src/services/demo/demoStory";
import { measureWorkspaceStorage } from "../src/services/maintenance/storageTotals.service";
import { isAllowedLinkUrl } from "../src/utils/externalRef";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The shared demo is open to everyone, so it is protected: it starts again every hour, its own app cannot be
// switched off or replaced, and visitors always have free app slots.

const app = createApp();
const PASSWORD = "a-good-password";
const originalEnv = { ...env };
const authed = (token: string) => ({ authorization: `Bearer ${token}` });
const GLOBAL_ID = new Types.ObjectId(STORAGE_GLOBAL_WORKSPACE_ID);

const demoWorkspace = async () => (await Workspace.findOne({ slug: DEMO_WORKSPACE_SLUG }).lean())!;
const demoLogin = async () => (await request(app).post("/api/auth/demo")).body.data as { token: string; user: { workspaceId: string; isDemo: boolean } };
const total = async (workspaceId: unknown) => (await StorageUsage.findOne({ workspaceId, day: STORAGE_TOTAL_KEY }).lean())?.bytes ?? 0;

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(() => {
  Object.assign(env, originalEnv);
});

describe("the demo story", () => {
  it("links the wrong refund to the matching action in AgentGuard's demo with a link AgentReplay accepts", () => {
    const link = agentGuardLink("https://agentguard.sritaraksolutions.in/");
    expect(link).toBe(`https://agentguard.sritaraksolutions.in/activity?action=${AGENTGUARD_DEMO_ACTION_ID}`);
    expect(isAllowedLinkUrl(link, true)).toBe(true);
  });
});

describe("what a reset puts in the demo", () => {
  beforeAll(async () => {
    await resetDemoWorkspace();
  });

  it("makes one app that is part of the demo, active, with its key never shown", async () => {
    const workspace = await demoWorkspace();
    const apps = await App.find({ workspaceId: workspace._id }).lean();
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ name: "Acme Support bot", seeded: true, active: true });
  });

  it("tells the refund story: five recorded runs and a fork that fixes the wrong answer", async () => {
    const workspace = await demoWorkspace();
    const runs = await Run.find({ workspaceId: workspace._id }).lean();
    expect(runs).toHaveLength(6);
    expect(runs.map((run) => run.status).sort()).toEqual(["failed", "ok", "ok", "ok", "ok", "ok"]);

    const wrong = runs.find((run) => run.externalId === WRONG_RUN_ID)!;
    const fork = runs.find((run) => String(run.parentRunId) === String(wrong._id))!;
    expect(fork).toBeTruthy();
    const wrongSteps = await Step.find({ runId: wrong._id }).sort({ index: 1 }).lean();
    const forkSteps = await Step.find({ runId: fork._id }).sort({ index: 1 }).lean();
    expect(wrongSteps[1].output).toContain("₹1,800");
    expect(forkSteps[1].output).toContain("₹2,400");
    expect(forkSteps[1].origin).toBe("rerun");
    // Before the fork point steps are copied, and after it tools were not run: their results are only reused.
    expect(forkSteps[0].origin).toBe("copied");
    expect(forkSteps[2].origin).toBe("simulated");
  });

  it("links the wrong refund step to AgentGuard, and no other step", async () => {
    const workspace = await demoWorkspace();
    const wrong = (await Run.findOne({ workspaceId: workspace._id, externalId: WRONG_RUN_ID }).lean())!;
    const refund = (await Step.findOne({ runId: wrong._id, index: 2 }).lean())!;
    expect(refund.externalRef).toMatchObject({ system: "agentguard", id: AGENTGUARD_DEMO_ACTION_ID });
    expect(refund.externalRef!.url).toBe(agentGuardLink(env.AGENTGUARD_DEMO_URL));
  });

  it("saves the tests and has run them once, and they pass", async () => {
    const workspace = await demoWorkspace();
    const tests = await TestCase.find({ workspaceId: workspace._id }).lean();
    expect(tests.map((test) => test.name).sort()).toEqual(DEMO_TESTS.map((test) => test.name).sort());
    const results = await TestResult.find({ workspaceId: workspace._id }).lean();
    expect(results).toHaveLength(DEMO_TESTS.length);
    expect(results.every((result) => result.outcome === "passed")).toBe(true);
  });

  it("starts the counters from what is really stored, and does not use up the visitors' fork or test-run slots", async () => {
    const workspace = await demoWorkspace();
    expect(await total(workspace._id)).toBe(await measureWorkspaceStorage(workspace._id));
    expect(await total(workspace._id)).toBeGreaterThan(0);
    expect(await StorageUsage.countDocuments({ workspaceId: workspace._id, day: { $ne: STORAGE_TOTAL_KEY } })).toBe(0);
    expect((await ForkUsage.findOne({ workspaceId: workspace._id }).lean())?.count ?? 0).toBe(0);
    expect((await TestRunUsage.findOne({ workspaceId: workspace._id }).lean())?.count ?? 0).toBe(0);
  });
});

describe("starting again", () => {
  it("wipes everything a visitor made and brings the story back", async () => {
    await resetDemoWorkspace();
    const visitor = await demoLogin();
    const workspace = await demoWorkspace();
    // The visitor adds an app and a run, and deletes a test.
    const mine = await request(app).post("/api/apps").set(authed(visitor.token)).send({ name: "My own app" });
    await request(app).post("/api/ingest").set("x-api-key", mine.body.data.apiKey).send({ runs: [{ id: "mine", name: "My run" }], steps: [{ runId: "mine", index: 0, type: "tool", name: "x", input: "y".repeat(5000) }] });
    await TestCase.deleteOne({ workspaceId: workspace._id });
    expect(await Run.countDocuments({ workspaceId: workspace._id })).toBe(7);

    await resetDemoWorkspace();
    expect(await App.countDocuments({ workspaceId: workspace._id })).toBe(1);
    expect(await App.countDocuments({ workspaceId: workspace._id, name: "My own app" })).toBe(0);
    expect(await Run.countDocuments({ workspaceId: workspace._id })).toBe(6);
    expect(await Run.countDocuments({ workspaceId: workspace._id, name: "My run" })).toBe(0);
    expect(await TestCase.countDocuments({ workspaceId: workspace._id })).toBe(DEMO_TESTS.length);
    // No steps are left behind from the runs that were wiped.
    const runIds = (await Run.find({ workspaceId: workspace._id }).select("_id").lean()).map((run) => run._id);
    expect(await Step.countDocuments({ runId: { $nin: runIds }, name: "x" })).toBe(0);
  });

  it("puts the demo's counters back to what is really stored, even when they were full", async () => {
    await resetDemoWorkspace();
    const workspace = await demoWorkspace();
    await StorageUsage.updateOne({ workspaceId: workspace._id, day: STORAGE_TOTAL_KEY }, { $set: { bytes: MAX_BYTES_PER_WORKSPACE_TOTAL } });
    await StorageUsage.updateOne({ workspaceId: workspace._id, day: "2026-01-01" }, { $set: { bytes: 5 * 1024 * 1024 } }, { upsert: true });
    await resetDemoWorkspace();
    expect(await total(workspace._id)).toBe(await measureWorkspaceStorage(workspace._id));
    expect(await total(workspace._id)).toBeLessThan(200 * 1024);
    expect(await StorageUsage.countDocuments({ workspaceId: workspace._id, day: { $ne: STORAGE_TOTAL_KEY } })).toBe(0);
  });

  it("keeps the global total honest: what the wipe removed comes off, what the seed added goes on", async () => {
    await resetDemoWorkspace();
    const workspace = await demoWorkspace();
    const before = (await StorageUsage.findOne({ workspaceId: GLOBAL_ID, day: STORAGE_GLOBAL_KEY }).lean())?.bytes ?? 0;
    const demoBefore = await total(workspace._id);
    await StorageUsage.updateOne({ workspaceId: workspace._id, day: STORAGE_TOTAL_KEY }, { $inc: { bytes: 50_000 } });
    await StorageUsage.updateOne({ workspaceId: GLOBAL_ID, day: STORAGE_GLOBAL_KEY }, { $inc: { bytes: 50_000 } });
    await resetDemoWorkspace();
    const after = (await StorageUsage.findOne({ workspaceId: GLOBAL_ID, day: STORAGE_GLOBAL_KEY }).lean())!.bytes;
    expect(after).toBe(before - demoBefore + (await total(workspace._id)));
  });

  it("never touches another workspace", async () => {
    const signup = await request(app).post("/api/auth/signup").send({ name: "Real Person", workspaceName: "Real team", email: "real@demo-protect.test.example", password: PASSWORD });
    const created = await request(app).post("/api/apps").set(authed(signup.body.data.token)).send({ name: "Real app" });
    await request(app).post("/api/ingest").set("x-api-key", created.body.data.apiKey).send({ runs: [{ id: "real", name: "Real run" }] });
    const realBefore = await total(signup.body.data.user.workspaceId);

    await resetDemoWorkspace();
    expect(await Run.countDocuments({ appId: created.body.data.id })).toBe(1);
    expect(await App.countDocuments({ workspaceId: signup.body.data.user.workspaceId })).toBe(1);
    expect(await total(signup.body.data.user.workspaceId)).toBe(realBefore);
  });

  it("refuses to wipe a workspace that is not marked as a demo", async () => {
    await resetDemoWorkspace();
    await Workspace.updateOne({ slug: DEMO_WORKSPACE_SLUG }, { $set: { isDemo: false } });
    await expect(resetDemoWorkspace()).rejects.toThrow();
    expect(await Run.countDocuments({ workspaceId: (await demoWorkspace())._id })).toBe(6);
    await Workspace.updateOne({ slug: DEMO_WORKSPACE_SLUG }, { $set: { isDemo: true } });
  });
});

describe("when the reset happens", () => {
  it("is due once an hour: the first visitor starts it, the next ones do not", async () => {
    Object.assign(env, { DEMO_AUTO_RESET: true });
    const start = new Date("2030-01-01T10:00:00Z");
    expect(await resetDemoIfDue(start)).toBe(true);
    expect(await resetDemoIfDue(new Date(start.getTime() + 59 * 60_000))).toBe(false);
    expect(await resetDemoIfDue(new Date(start.getTime() + 60 * 60_000))).toBe(true);
  });

  it("only one of many callers at the same moment does the reset", async () => {
    Object.assign(env, { DEMO_AUTO_RESET: true });
    const now = new Date("2030-02-01T10:00:00Z");
    const results = await Promise.all(Array.from({ length: 6 }, () => resetDemoIfDue(now)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("does nothing when demo mode or the automatic reset is off", async () => {
    Object.assign(env, { DEMO_AUTO_RESET: false });
    expect(await resetDemoIfDue(new Date("2030-03-01T10:00:00Z"))).toBe(false);
    Object.assign(env, { DEMO_AUTO_RESET: true, DEMO_MODE: false });
    expect(await resetDemoIfDue(new Date("2030-03-01T10:00:00Z"))).toBe(false);
  });

  it("lets the next visitor try again soon when a reset fails, instead of waiting an hour", async () => {
    Object.assign(env, { DEMO_AUTO_RESET: true });
    await Workspace.updateOne({ slug: DEMO_WORKSPACE_SLUG }, { $set: { isDemo: false } });
    const now = new Date("2030-04-01T10:00:00Z");
    expect(await resetDemoIfDue(now)).toBe(false); // failed: the workspace is not a demo
    await Workspace.updateOne({ slug: DEMO_WORKSPACE_SLUG }, { $set: { isDemo: true } });
    expect(await resetDemoIfDue(new Date(now.getTime() + 1000))).toBe(true);
  });

  it("happens when someone presses \"Try the demo\" and it is due, and the visitor is told it is the demo", async () => {
    Object.assign(env, { DEMO_AUTO_RESET: true });
    await Run.deleteMany({ workspaceId: (await demoWorkspace())._id });
    await App.deleteMany({ workspaceId: (await demoWorkspace())._id });
    // A reset happened a moment ago in an earlier test, so move the clock the job remembers back.
    await MaintenanceLog.updateOne({ name: "demo-reset" }, { $set: { lastRunAt: new Date(0) } });
    const session = await demoLogin();
    expect(session.user.isDemo).toBe(true);
    expect(await Run.countDocuments({ workspaceId: session.user.workspaceId })).toBe(6);
  });

  it("tells a normal user their workspace is not the demo", async () => {
    const signup = await request(app).post("/api/auth/signup").send({ name: "Normal", workspaceName: "Normal team", email: "normal@demo-protect.test.example", password: PASSWORD });
    expect(signup.body.data.user.isDemo).toBe(false);
    const me = await request(app).get("/api/auth/me").set(authed(signup.body.data.token));
    expect(me.body.data.isDemo).toBe(false);
  });
});

describe("the demo's own app", () => {
  it("cannot be switched off, even by the demo visitor", async () => {
    await resetDemoWorkspace();
    const visitor = await demoLogin();
    const seeded = (await App.findOne({ workspaceId: visitor.user.workspaceId, seeded: true }).select("+apiKeyHash").lean())!;
    const res = await request(app).post(`/api/apps/${seeded._id}/revoke-key`).set(authed(visitor.token));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("This app is part of the demo, so its key can't be changed.");
    expect(await App.findById(seeded._id).lean()).toMatchObject({ active: true });
  });

  it("cannot get a new key", async () => {
    const visitor = await demoLogin();
    const seeded = (await App.findOne({ workspaceId: visitor.user.workspaceId, seeded: true }).select("+apiKeyHash").lean())!;
    const res = await request(app).post(`/api/apps/${seeded._id}/rotate-key`).set(authed(visitor.token));
    expect(res.status).toBe(403);
    expect((await App.findById(seeded._id).select("+apiKeyHash").lean())!.apiKeyHash).toBe(seeded.apiKeyHash);
  });

  it("is shown as part of the demo in the list, while the visitor's own apps can still be changed", async () => {
    const visitor = await demoLogin();
    const mine = await request(app).post("/api/apps").set(authed(visitor.token)).send({ name: "Mine" });
    const list = await request(app).get("/api/apps").set(authed(visitor.token));
    expect(list.body.data.find((item: { name: string }) => item.name === "Acme Support bot").seeded).toBe(true);
    expect(list.body.data.find((item: { name: string }) => item.name === "Mine").seeded).toBe(false);
    expect((await request(app).post(`/api/apps/${mine.body.data.id}/revoke-key`).set(authed(visitor.token))).status).toBe(200);
  });

  it("does not use up a visitor's app slots", async () => {
    await resetDemoWorkspace();
    const visitor = await demoLogin();
    for (let index = 0; index < MAX_APPS_PER_WORKSPACE; index++) {
      const res = await request(app).post("/api/apps").set(authed(visitor.token)).send({ name: `App ${index}` });
      expect(res.status).toBe(201);
    }
    const tooMany = await request(app).post("/api/apps").set(authed(visitor.token)).send({ name: "One too many" });
    expect(tooMany.status).toBe(400);
  });
});
