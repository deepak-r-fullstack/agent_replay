import request from "supertest";
import { Types } from "mongoose";
import { createApp } from "../src/app";
import { MAX_BYTES_GLOBAL, RUN_STORAGE_BYTES, STORAGE_GLOBAL_KEY, STORAGE_GLOBAL_WORKSPACE_ID, STORAGE_TOTAL_KEY } from "../src/constants";
import { Run } from "../src/models/run.model";
import { StorageUsage } from "../src/models/storageUsage.model";
import { TestCase } from "../src/models/testCase.model";
import { TestResult } from "../src/models/testResult.model";
import { assertStorageRoom, dayKey, releaseStorage, reserveStorage } from "../src/services/ingest/storageQuota.service";
import { runStorageCleanup } from "../src/services/maintenance/storageCleanup.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// One storage limit across ALL workspaces, because new workspaces are free and the Atlas cluster is shared with AgentGuard.

const app = createApp();
const PASSWORD = "a-good-password";
const RUN = RUN_STORAGE_BYTES;
const GLOBAL = MAX_BYTES_GLOBAL;
const GLOBAL_ID = new Types.ObjectId(STORAGE_GLOBAL_WORKSPACE_ID);
const TODAY = dayKey(new Date());

interface Team {
  token: string;
  workspaceId: string;
  appId: string;
  apiKey: string;
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

async function teamFrom(token: string, workspaceId: string, appName = "Support bot"): Promise<Team> {
  const created = await request(app).post("/api/apps").set(authed(token)).send({ name: `${appName} ${Math.random()}` });
  return { token, workspaceId, appId: created.body.data.id, apiKey: created.body.data.apiKey };
}

async function makeTeam(label: string): Promise<Team> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ name: "Test Person", workspaceName: `Team ${label}`, email: `${label}@global.test.example`, password: PASSWORD });
  return teamFrom(signup.body.data.token, signup.body.data.user.workspaceId);
}

const send = (team: Team, body: unknown) => request(app).post("/api/ingest").set("x-api-key", team.apiKey).send(body as object);
const stepOf = (runId: string, index: number, bytes: number) => ({ runId, index, type: "tool", name: "a", input: "b".repeat(bytes - 1), output: "" });

const setGlobal = (bytes: number) => StorageUsage.updateOne({ workspaceId: GLOBAL_ID, day: STORAGE_GLOBAL_KEY }, { $set: { bytes } }, { upsert: true });
const globalBytes = async () => (await StorageUsage.findOne({ workspaceId: GLOBAL_ID, day: STORAGE_GLOBAL_KEY }).lean())?.bytes ?? 0;
const usage = async (team: Team, day = TODAY) => (await StorageUsage.findOne({ workspaceId: team.workspaceId, day }).lean())?.bytes ?? 0;

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await setGlobal(0);
});

describe("the global limit", () => {
  it("is 250 MB", () => {
    expect(GLOBAL).toBe(250 * 1024 * 1024);
  });

  it("counts what every workspace saves in one shared total", async () => {
    const first = await makeTeam("count-one");
    const second = await makeTeam("count-two");
    await send(first, { steps: [stepOf("r", 0, 500)] });
    await send(second, { steps: [stepOf("r", 0, 300)] });
    expect(await globalBytes()).toBe(800 + 2 * RUN);
    expect(await globalBytes()).toBe((await usage(first, STORAGE_TOTAL_KEY)) + (await usage(second, STORAGE_TOTAL_KEY)));
  });

  it("refuses everyone once the whole service is full, with a friendly 429, and saves nothing", async () => {
    const full = await makeTeam("full-one");
    const other = await makeTeam("full-two");
    await setGlobal(GLOBAL - 100);
    for (const team of [full, other]) {
      const res = await send(team, { runs: [{ id: "r", name: "Too much" }], steps: [stepOf("r", 0, 101)] });
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ success: false, message: "AgentReplay is full for now, so nothing new can be saved. Please try again later." });
      expect(await Run.countDocuments({ appId: team.appId })).toBe(0);
      // The workspace's own counters are given back, so a refused batch leaves no trace.
      expect(await usage(team)).toBe(0);
      expect(await usage(team, STORAGE_TOTAL_KEY)).toBe(0);
    }
    expect(await globalBytes()).toBe(GLOBAL - 100);
  });

  it("accepts a batch that lands exactly on the limit, and refuses the next byte", async () => {
    const team = await makeTeam("exact");
    await setGlobal(GLOBAL - 1000 - RUN);
    expect((await send(team, { steps: [stepOf("r", 0, 1000)] })).status).toBe(200);
    expect(await globalBytes()).toBe(GLOBAL);
    expect((await send(team, { steps: [stepOf("r", 1, 1)] })).status).toBe(429);
    expect(await globalBytes()).toBe(GLOBAL);
  });

  it("holds when many batches from different workspaces arrive at the same moment", async () => {
    const teams = await Promise.all(Array.from({ length: 4 }, (_, index) => makeTeam(`race-${index}`)));
    const PER = 1000 + RUN;
    await setGlobal(GLOBAL - 3 * PER);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => send(teams[index % 4], { steps: [stepOf(`run-${index}`, 0, 1000)] })));
    expect(results.filter((res) => res.status === 200)).toHaveLength(3);
    expect(results.filter((res) => res.status === 429)).toHaveLength(9);
    expect(await globalBytes()).toBe(GLOBAL);
  });

  it("does not use up room when a batch is sent again", async () => {
    const team = await makeTeam("repeat");
    const batch = { runs: [{ id: "r" }], steps: [stepOf("r", 0, 700)] };
    await send(team, batch);
    const after = await globalBytes();
    await send(team, batch);
    expect(await globalBytes()).toBe(after);
  });

  it("also protects the demo and forks, because they use the same room check", async () => {
    const demo = await request(app).post("/api/auth/demo");
    await setGlobal(GLOBAL);
    const workspaceId = new Types.ObjectId(demo.body.data.user.workspaceId);
    await expect(assertStorageRoom(workspaceId, 1)).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe("giving room back", () => {
  it("lowers the global total when a reservation is released", async () => {
    const team = await makeTeam("release");
    const workspaceId = new Types.ObjectId(team.workspaceId);
    expect(await reserveStorage(workspaceId, false, 5000)).toBeNull();
    expect(await globalBytes()).toBe(5000);
    await releaseStorage(workspaceId, 5000);
    expect(await globalBytes()).toBe(0);
    expect(await usage(team, STORAGE_TOTAL_KEY)).toBe(0);
  });

  it("never lets the global total go below zero", async () => {
    const team = await makeTeam("floor");
    await releaseStorage(new Types.ObjectId(team.workspaceId), 5000);
    expect(await globalBytes()).toBe(0);
  });

  it("goes down when a test with results is deleted", async () => {
    const team = await makeTeam("delete-test");
    const test = await TestCase.create({ workspaceId: team.workspaceId, name: "T", sourceRunId: new Types.ObjectId(), sourceStepIndex: 0, input: "{}", checks: [] });
    await TestResult.insertMany([1, 2].map(() => ({ workspaceId: team.workspaceId, testCaseId: test._id, suiteRunId: new Types.ObjectId(), outcome: "passed", change: "same", passed: true })));
    await setGlobal(50_000);
    await StorageUsage.updateOne({ workspaceId: team.workspaceId, day: STORAGE_TOTAL_KEY }, { $set: { bytes: 50_000 } }, { upsert: true });
    await request(app).delete(`/api/tests/${test._id}`).set(authed(team.token));
    expect(await globalBytes()).toBe(50_000 - 2 * 4096);
  });
});

describe("the daily clean-up and the global total", () => {
  it("sets the global total to the sum of every workspace's real total", async () => {
    const first = await makeTeam("sum-one");
    const second = await makeTeam("sum-two");
    await send(first, { runs: [{ id: "a" }, { id: "b" }] });
    await send(second, { runs: [{ id: "a" }] });
    await setGlobal(200 * 1024 * 1024); // drifted far too high
    await runStorageCleanup();
    // Other workspaces from earlier tests in this file are part of the sum, so compare with the real sum.
    const totals = await StorageUsage.find({ day: STORAGE_TOTAL_KEY }).lean();
    expect(await globalBytes()).toBe(totals.reduce((sum, item) => sum + item.bytes, 0));
    expect(await usage(first, STORAGE_TOTAL_KEY)).toBe(2 * RUN);
    expect(await usage(second, STORAGE_TOTAL_KEY)).toBe(RUN);
  });
});
