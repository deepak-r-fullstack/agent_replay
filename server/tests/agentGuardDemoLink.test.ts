import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { AGENTGUARD_DEMO_APP_NAME, DEMO_WORKSPACE_SLUG, LINKED_DEMO_RUN_KEEP_MS } from "../src/constants";
import { App } from "../src/models/app.model";
import { Run } from "../src/models/run.model";
import { Step } from "../src/models/step.model";
import { Workspace } from "../src/models/workspace.model";
import { ensureAgentGuardDemoApp } from "../src/services/demo/agentGuardDemoApp.service";
import { resetDemoWorkspace } from "../src/services/demo/demoSeed.service";
import { measureWorkspaceStorage } from "../src/services/maintenance/storageTotals.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// AgentGuard's guided demo records each visitor's booking into the shared demo workspace, so pressing "Try the demo"
// opens that exact recording. These tests cover the linked app, the "did my recording arrive?" check, and the
// AgentGuard links a run shows at its top.

const app = createApp();
const originalEnv = { ...env };
const PASSWORD = "a-good-password";
const authed = (token: string) => ({ authorization: `Bearer ${token}` });
const newKey = () => `ar_${crypto.randomBytes(24).toString("hex")}`;
const ACTION_ID = "6720f0c1a2b3c4d5e6f70812";
const OTHER_ACTION_ID = "6720f0c1a2b3c4d5e6f70999";
const linkTo = (id: string) => ({ system: "agentguard", id, url: `https://agentguard.example.com/activity?action=${id}` });

// What AgentGuard sends for one guided booking: the request, the decision and the result, all linked to one action.
function journey(runId: string, actionId = ACTION_ID, startedAt?: string) {
  return {
    runs: [{ id: runId, name: "Guided demo: cancel DEMO-ABC", userRef: "Demo support visitor", status: "ok", ...(startedAt ? { startedAt } : {}) }],
    steps: [
      { runId, index: 0, type: "tool", name: "booking.cancel requested", input: "{}", output: "{}", externalRef: linkTo(actionId) },
      { runId, index: 1, type: "custom", name: "Manager decision", input: "{}", output: "{}", externalRef: linkTo(actionId) },
      { runId, index: 2, type: "tool", name: "booking.cancel run by AgentGuard", input: "{}", output: "{}", externalRef: linkTo(actionId) },
    ],
  };
}

const demoWorkspace = async () => (await Workspace.findOne({ slug: DEMO_WORKSPACE_SLUG }).lean())!;
const demoToken = async () => (await request(app).post("/api/auth/demo")).body.data.token as string;
const lookup = (key: string, runId: string, ref?: string) =>
  request(app)
    .get(`/api/ingest/runs/${encodeURIComponent(runId)}`)
    .query(ref ? { ref } : {})
    .set("x-api-key", key);

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

afterEach(() => {
  Object.assign(env, originalEnv);
});

describe("the AgentGuard guided demo app", () => {
  it("is not created when no key is set, so the demo looks exactly as before", async () => {
    env.AGENTGUARD_DEMO_SDK_KEY = "";
    await resetDemoWorkspace();
    const workspace = await demoWorkspace();
    expect(await App.countDocuments({ workspaceId: workspace._id, linkedDemo: true })).toBe(0);
  });

  it("is created in the demo workspace with the configured key, protected like the demo's own app", async () => {
    const key = newKey();
    env.AGENTGUARD_DEMO_SDK_KEY = key;
    await resetDemoWorkspace();
    const workspace = await demoWorkspace();
    const linked = await App.findOne({ workspaceId: workspace._id, linkedDemo: true }).lean();
    expect(linked).toMatchObject({ name: AGENTGUARD_DEMO_APP_NAME, seeded: true, active: true });

    // The key works for sending, and visitors cannot switch it off or replace it.
    expect((await request(app).post("/api/ingest").set("x-api-key", key).send(journey("works"))).status).toBe(200);
    const token = await demoToken();
    expect((await request(app).post(`/api/apps/${linked!._id}/revoke-key`).set(authed(token))).status).toBe(403);
    expect((await request(app).post(`/api/apps/${linked!._id}/rotate-key`).set(authed(token))).status).toBe(403);
    // The key is never shown, not even its hash.
    const listed = await request(app).get("/api/apps").set(authed(token));
    expect(JSON.stringify(listed.body)).not.toContain(key);
  });

  it("is made once even when several servers prepare it at the same moment, and follows a changed key", async () => {
    env.AGENTGUARD_DEMO_SDK_KEY = newKey();
    await resetDemoWorkspace();
    const workspace = await demoWorkspace();
    await Promise.all(Array.from({ length: 5 }, () => ensureAgentGuardDemoApp(workspace._id)));
    expect(await App.countDocuments({ workspaceId: workspace._id, linkedDemo: true })).toBe(1);

    const replaced = newKey();
    env.AGENTGUARD_DEMO_SDK_KEY = replaced;
    await ensureAgentGuardDemoApp(workspace._id);
    expect((await request(app).post("/api/ingest").set("x-api-key", replaced).send(journey("after-change"))).status).toBe(200);
  });

  it("stops accepting the old key once the setting is removed", async () => {
    const key = newKey();
    env.AGENTGUARD_DEMO_SDK_KEY = key;
    await resetDemoWorkspace();
    env.AGENTGUARD_DEMO_SDK_KEY = "";
    await resetDemoWorkspace();
    expect((await request(app).post("/api/ingest").set("x-api-key", key).send(journey("refused"))).status).toBe(401);
  });

  it("keeps a visitor's recent recording through the hourly reset, but not old ones, forks or other apps", async () => {
    const key = newKey();
    env.AGENTGUARD_DEMO_SDK_KEY = key;
    await resetDemoWorkspace();
    const workspace = await demoWorkspace();
    await request(app).post("/api/ingest").set("x-api-key", key).send(journey("fresh-recording"));
    const dayAndMore = new Date(Date.now() - LINKED_DEMO_RUN_KEEP_MS - 60_000).toISOString();
    await request(app).post("/api/ingest").set("x-api-key", key).send(journey("old-recording", ACTION_ID, dayAndMore));
    // A visitor forks the fresh recording and adds an app of their own.
    const token = await demoToken();
    const fresh = await Run.findOne({ workspaceId: workspace._id, externalId: "fresh-recording" }).lean();
    expect((await request(app).post(`/api/runs/${fresh!._id}/fork`).set(authed(token)).send({ fromStepIndex: 2, edits: { 2: { output: "pretend" } } })).status).toBe(201);
    await request(app).post("/api/apps").set(authed(token)).send({ name: "Visitor app" });

    await resetDemoWorkspace();
    const kept = await Run.find({ workspaceId: workspace._id, appId: fresh!.appId }).lean();
    expect(kept.map((run) => run.externalId)).toContain("fresh-recording");
    expect(kept.map((run) => run.externalId)).not.toContain("old-recording");
    expect(kept.every((run) => run.externalId && !run.parentRunId)).toBe(true); // the fork is gone
    expect(await Step.countDocuments({ runId: fresh!._id })).toBe(3);
    expect(await App.countDocuments({ workspaceId: workspace._id, name: "Visitor app" })).toBe(0);
    // The demo story is back, next to the kept recordings.
    expect(await Run.countDocuments({ workspaceId: workspace._id })).toBe(6 + kept.length);
    // No steps are left behind from wiped runs.
    const runIds = (await Run.find({}).select("_id").lean()).map((run) => run._id);
    expect(await Step.countDocuments({ runId: { $nin: runIds } })).toBe(0);
  });

  it("counts the kept recording in the demo's storage total", async () => {
    env.AGENTGUARD_DEMO_SDK_KEY = newKey();
    await resetDemoWorkspace();
    await request(app).post("/api/ingest").set("x-api-key", env.AGENTGUARD_DEMO_SDK_KEY).send(journey("counted"));
    await resetDemoWorkspace();
    const workspace = await demoWorkspace();
    const { StorageUsage } = await import("../src/models/storageUsage.model");
    const total = (await StorageUsage.findOne({ workspaceId: workspace._id, day: "total" }).lean())?.bytes;
    expect(total).toBe(await measureWorkspaceStorage(workspace._id));
  });
});

describe("checking that a recording arrived", () => {
  let key = "";
  let otherKey = "";

  beforeAll(async () => {
    const signup = await request(app).post("/api/auth/signup").send({ name: "Owner", workspaceName: "Lookup Team", email: "lookup@agentguard-link.test.example", password: PASSWORD });
    const token = signup.body.data.token;
    key = (await request(app).post("/api/apps").set(authed(token)).send({ name: "Recorder" })).body.data.apiKey;
    otherKey = (await request(app).post("/api/apps").set(authed(token)).send({ name: "Another recorder" })).body.data.apiKey;
    await request(app).post("/api/ingest").set("x-api-key", key).send(journey("arrived"));
    // The other app happens to use the same run id for an unrelated run.
    await request(app).post("/api/ingest").set("x-api-key", otherKey).send({ runs: [{ id: "shared-id", name: "Other" }] });
  });

  it("finds the app's own run and confirms it links to the expected action", async () => {
    const found = await lookup(key, "arrived", ACTION_ID);
    expect(found.status).toBe(200);
    expect(found.body.data).toEqual({ externalId: "arrived", status: "ok", stepCount: 3, linked: true });
  });

  it("never confirms a link to a different action, so an unrelated recording is never offered", async () => {
    const other = await lookup(key, "arrived", OTHER_ACTION_ID);
    expect(other.status).toBe(200);
    expect(other.body.data.linked).toBe(false);
    expect((await lookup(key, "arrived")).body.data.linked).toBe(false);
  });

  it("says not found for a run that has not arrived, and for another app's run with the same id", async () => {
    expect((await lookup(key, "not-yet", ACTION_ID)).status).toBe(404);
    expect((await lookup(key, "shared-id")).status).toBe(404);
    expect((await lookup(otherKey, "arrived", ACTION_ID)).status).toBe(404);
  });

  it("needs a valid key and returns no recorded text", async () => {
    expect((await request(app).get("/api/ingest/runs/arrived")).status).toBe(401);
    expect((await lookup(newKey(), "arrived")).status).toBe(401);
    const found = await lookup(key, "arrived", ACTION_ID);
    expect(JSON.stringify(found.body)).not.toContain("Guided demo");
    expect(JSON.stringify(found.body)).not.toContain("Manager decision");
  });

  it("refuses an oversized reference", async () => {
    expect((await lookup(key, "arrived", "x".repeat(500))).status).toBe(400);
  });
});

describe("the AgentGuard links at the top of a run", () => {
  it("lists each linked action once, in step order, and only safe links", async () => {
    const signup = await request(app).post("/api/auth/signup").send({ name: "Viewer", workspaceName: "Links Team", email: "runlinks@agentguard-link.test.example", password: PASSWORD });
    const token = signup.body.data.token;
    const key = (await request(app).post("/api/apps").set(authed(token)).send({ name: "Recorder" })).body.data.apiKey;
    await request(app).post("/api/ingest").set("x-api-key", key).send(journey("with-links"));
    const run = await Run.findOne({ externalId: "with-links" }).lean();
    // A link saved before today's rules, which would not be accepted now, is not shown.
    await Step.updateOne({ runId: run!._id, index: 2 }, { $set: { externalRef: { system: "agentguard", id: OTHER_ACTION_ID, url: "javascript:alert(1)" } } });

    const detail = await request(app).get(`/api/runs/${run!._id}`).set(authed(token));
    expect(detail.status).toBe(200);
    expect(detail.body.data.links).toEqual([linkTo(ACTION_ID)]);
  });

  it("is an empty list for a run with no links, and another team cannot read the run at all", async () => {
    const signup = await request(app).post("/api/auth/signup").send({ name: "Plain", workspaceName: "Plain Team", email: "plain@agentguard-link.test.example", password: PASSWORD });
    const token = signup.body.data.token;
    const key = (await request(app).post("/api/apps").set(authed(token)).send({ name: "Recorder" })).body.data.apiKey;
    await request(app).post("/api/ingest").set("x-api-key", key).send({ runs: [{ id: "no-links", name: "Plain" }], steps: [{ runId: "no-links", index: 0, type: "tool", name: "x" }] });
    const run = await Run.findOne({ externalId: "no-links" }).lean();
    expect((await request(app).get(`/api/runs/${run!._id}`).set(authed(token))).body.data.links).toEqual([]);

    const linked = await Run.findOne({ externalId: "with-links" }).lean();
    expect((await request(app).get(`/api/runs/${linked!._id}`).set(authed(token))).status).toBe(404);
  });
});
