import request from "supertest";
import { Types } from "mongoose";
import { createApp } from "../src/app";
import { MAX_TEST_OUTPUT_BYTES, RUN_STORAGE_BYTES, STORAGE_TOTAL_KEY } from "../src/constants";
import { MaintenanceLog } from "../src/models/maintenanceLog.model";
import { Run } from "../src/models/run.model";
import { StorageUsage } from "../src/models/storageUsage.model";
import { TestCase } from "../src/models/testCase.model";
import { TestResult } from "../src/models/testResult.model";
import { lowerStorage } from "../src/services/ingest/storageQuota.service";
import { claimJob } from "../src/services/maintenance/claimJob";
import { runStorageCleanup } from "../src/services/maintenance/storageCleanup.service";
import { measureWorkspaceStorage } from "../src/services/maintenance/storageTotals.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The all-time storage total follows deletions, and a daily clean-up works it out again from the real data.

const app = createApp();
const PASSWORD = "a-good-password";
const RUN = RUN_STORAGE_BYTES;
const RESULT = MAX_TEST_OUTPUT_BYTES;

interface Team {
  token: string;
  workspaceId: string;
  appId: string;
  apiKey: string;
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

async function makeTeam(label: string): Promise<Team> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ name: "Test Person", workspaceName: `Team ${label}`, email: `${label}@cleanup.test.example`, password: PASSWORD });
  const token = signup.body.data.token as string;
  const created = await request(app).post("/api/apps").set(authed(token)).send({ name: "Support bot" });
  return { token, workspaceId: signup.body.data.user.workspaceId, appId: created.body.data.id, apiKey: created.body.data.apiKey };
}

const send = (team: Team, body: unknown) => request(app).post("/api/ingest").set("x-api-key", team.apiKey).send(body as object);
const total = async (team: Team) => (await StorageUsage.findOne({ workspaceId: team.workspaceId, day: STORAGE_TOTAL_KEY }).lean())?.bytes ?? 0;
const setTotal = (team: Team, bytes: number) => StorageUsage.updateOne({ workspaceId: team.workspaceId, day: STORAGE_TOTAL_KEY }, { $set: { bytes } }, { upsert: true });

// A saved test with some results, put straight into the database.
async function addTestWithResults(team: Team, name: string, results: number, outcome: "passed" | "skipped" = "passed") {
  const test = await TestCase.create({ workspaceId: team.workspaceId, name, sourceRunId: new Types.ObjectId(), sourceStepIndex: 0, input: "{}", checks: [] });
  const suiteRunId = new Types.ObjectId();
  await TestResult.insertMany(
    Array.from({ length: results }, () => ({ workspaceId: team.workspaceId, testCaseId: test._id, suiteRunId, outcome, change: "same", passed: outcome === "passed" }))
  );
  return test;
}

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe("working out what a workspace really stores", () => {
  it("adds up step text, 1 KB per run and 4 KB per test result, and matches what saving counted", async () => {
    const team = await makeTeam("measure");
    await send(team, {
      runs: [{ id: "a" }, { id: "b" }],
      steps: [{ runId: "a", index: 0, type: "tool", name: "abc", input: "x".repeat(1000), output: "é".repeat(10), error: "e" }],
    });
    await addTestWithResults(team, "Refund test", 3);
    await addTestWithResults(team, "Skipped test", 2, "skipped"); // a skipped test gave its share back

    const stepText = 3 + 1000 + 20 + 1;
    expect(await measureWorkspaceStorage(team.workspaceId)).toBe(stepText + 2 * RUN + 3 * RESULT);
    // What the ingest counted for the same runs and steps is the same number.
    expect(await total(team)).toBe(stepText + 2 * RUN);
  });

  it("is zero for a workspace with nothing in it, and never mixes in another workspace", async () => {
    const empty = await makeTeam("measure-empty");
    const busy = await makeTeam("measure-busy");
    await send(busy, { runs: [{ id: "a" }] });
    expect(await measureWorkspaceStorage(empty.workspaceId)).toBe(0);
    expect(await measureWorkspaceStorage(busy.workspaceId)).toBe(RUN);
  });
});

describe("the daily clean-up", () => {
  it("brings a total that is too high down to the real number", async () => {
    const team = await makeTeam("cleanup-high");
    await send(team, { runs: [{ id: "a" }] });
    await setTotal(team, 90 * 1024 * 1024);
    await runStorageCleanup();
    expect(await total(team)).toBe(RUN);
  });

  it("lifts a total that is too low, and creates it when it is missing", async () => {
    const low = await makeTeam("cleanup-low");
    await send(low, { runs: [{ id: "a" }, { id: "b" }] });
    await setTotal(low, 0);
    const missing = await makeTeam("cleanup-missing");
    await Run.create({ workspaceId: missing.workspaceId, appId: missing.appId, name: "Made outside the API" });
    await runStorageCleanup();
    expect(await total(low)).toBe(2 * RUN);
    expect(await total(missing)).toBe(RUN);
  });

  it("follows test results that the database removed by itself after 30 days", async () => {
    const team = await makeTeam("cleanup-ttl");
    await addTestWithResults(team, "Old test", 5);
    await setTotal(team, 5 * RESULT);
    await TestResult.deleteMany({ workspaceId: team.workspaceId }); // what the TTL index does
    await runStorageCleanup();
    expect(await total(team)).toBe(0);
  });

  it("does not touch the daily counters", async () => {
    const team = await makeTeam("cleanup-days");
    await send(team, { runs: [{ id: "a" }] });
    const before = await StorageUsage.find({ workspaceId: team.workspaceId, day: { $ne: STORAGE_TOTAL_KEY } }).lean();
    await runStorageCleanup();
    const after = await StorageUsage.find({ workspaceId: team.workspaceId, day: { $ne: STORAGE_TOTAL_KEY } }).lean();
    expect(after.map((item) => item.bytes)).toEqual(before.map((item) => item.bytes));
  });
});

describe("deleting a test", () => {
  it("brings the total down by the 4 KB each of its results was counted at", async () => {
    const team = await makeTeam("delete-test");
    const test = await addTestWithResults(team, "Delete me", 3);
    await addTestWithResults(team, "Keep me", 1);
    await setTotal(team, 4 * RESULT + 777);
    const res = await request(app).delete(`/api/tests/${test._id}`).set(authed(team.token));
    expect(res.status).toBe(200);
    expect(await TestResult.countDocuments({ testCaseId: test._id })).toBe(0);
    expect(await total(team)).toBe(RESULT + 777);
  });

  it("does not take anything off for skipped results, which gave their share back already", async () => {
    const team = await makeTeam("delete-skipped");
    const test = await addTestWithResults(team, "Skipped", 2, "skipped");
    await setTotal(team, 1000);
    await request(app).delete(`/api/tests/${test._id}`).set(authed(team.token));
    expect(await total(team)).toBe(1000);
  });

  it("never lets the total go below zero", async () => {
    const team = await makeTeam("delete-floor");
    const test = await addTestWithResults(team, "Floor", 2);
    await setTotal(team, 100);
    await request(app).delete(`/api/tests/${test._id}`).set(authed(team.token));
    expect(await total(team)).toBe(0);
    await lowerStorage(new Types.ObjectId(team.workspaceId), 5000);
    expect(await total(team)).toBe(0);
  });
});

describe("claiming a housekeeping job", () => {
  const HOUR = 60 * 60 * 1000;

  it("lets the first caller run it, and refuses the next one until the interval has passed", async () => {
    const start = new Date("2026-01-01T00:00:00Z");
    expect(await claimJob("job-a", 24 * HOUR, start)).toBe(true);
    expect(await claimJob("job-a", 24 * HOUR, new Date(start.getTime() + HOUR))).toBe(false);
    expect(await claimJob("job-a", 24 * HOUR, new Date(start.getTime() + 24 * HOUR))).toBe(true);
    expect(await MaintenanceLog.countDocuments({ name: "job-a" })).toBe(1);
  });

  it("keeps different jobs apart", async () => {
    const now = new Date();
    expect(await claimJob("job-b", HOUR, now)).toBe(true);
    expect(await claimJob("job-c", HOUR, now)).toBe(true);
  });

  it("lets only one of many callers at the same moment win", async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 10 }, () => claimJob("job-race", 24 * HOUR, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
