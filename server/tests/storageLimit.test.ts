import request from "supertest";
import { createApp } from "../src/app";
import {
  MAX_BYTES_PER_DEMO_WORKSPACE_PER_DAY,
  MAX_BYTES_PER_WORKSPACE_PER_DAY,
  MAX_BYTES_PER_WORKSPACE_TOTAL,
  STORAGE_TOTAL_KEY,
} from "../src/constants";
import { Run } from "../src/models/run.model";
import { StorageUsage } from "../src/models/storageUsage.model";
import { Step } from "../src/models/step.model";
import { dayKey, reserveStorage } from "../src/services/ingest/storageQuota.service";
import { AgentReplay } from "../../sdk/src";
import { FetchLike } from "../../sdk/src/types";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// A workspace may not fill the shared free database: a daily limit, a smaller one for the demo, and an all-time one.
// Everything goes through the real HTTP API with a real (in-memory) MongoDB.

const app = createApp();
const PASSWORD = "a-good-password";
const DAY = MAX_BYTES_PER_WORKSPACE_PER_DAY;
const DEMO_DAY = MAX_BYTES_PER_DEMO_WORKSPACE_PER_DAY;
const TOTAL = MAX_BYTES_PER_WORKSPACE_TOTAL;
const TODAY = dayKey(new Date());

interface Team {
  workspaceId: string;
  appId: string;
  apiKey: string;
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

async function makeTeam(label: string): Promise<Team> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ name: "Test Person", workspaceName: `Team ${label}`, email: `${label}@storage.test.example`, password: PASSWORD });
  const created = await request(app).post("/api/apps").set(authed(signup.body.data.token)).send({ name: "Support bot" });
  return { workspaceId: signup.body.data.user.workspaceId, appId: created.body.data.id, apiKey: created.body.data.apiKey };
}

// The demo workspace is open to anyone: "Try the demo", then add an app.
async function makeDemoTeam(): Promise<Team> {
  const demo = await request(app).post("/api/auth/demo");
  const created = await request(app).post("/api/apps").set(authed(demo.body.data.token)).send({ name: `Demo app ${Date.now()}` });
  return { workspaceId: demo.body.data.user.workspaceId, appId: created.body.data.id, apiKey: created.body.data.apiKey };
}

const send = (team: Team, body: unknown) => request(app).post("/api/ingest").set("x-api-key", team.apiKey).send(body as object);

// A step whose stored text is exactly `bytes` bytes long (a one-letter name plus the rest as input).
const stepOf = (runId: string, index: number, bytes: number) => ({
  runId,
  index,
  type: "tool",
  name: "a",
  input: "b".repeat(bytes - 1),
  output: "",
});

const setUsage = (team: Team, day: string, bytes: number) =>
  StorageUsage.updateOne({ workspaceId: team.workspaceId, day }, { $set: { bytes } }, { upsert: true });
const usage = async (team: Team, day = TODAY) => (await StorageUsage.findOne({ workspaceId: team.workspaceId, day }).lean())?.bytes ?? 0;
const runCount = (team: Team) => Run.countDocuments({ appId: team.appId });
const stepCount = async (team: Team) => {
  const runs = await Run.find({ appId: team.appId }).select("_id").lean();
  return Step.countDocuments({ runId: { $in: runs.map((run) => run._id) } });
};

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe("what counts", () => {
  it("counts the name, input, output and error of new steps, in bytes, for the day and in total", async () => {
    const team = await makeTeam("counts");
    const res = await send(team, {
      steps: [{ runId: "r", index: 0, type: "tool", name: "abc", input: "x".repeat(1000), output: "y".repeat(500), error: "e".repeat(10) }],
    });
    expect(res.status).toBe(200);
    expect(await usage(team)).toBe(1513);
    expect(await usage(team, STORAGE_TOTAL_KEY)).toBe(1513);
    await send(team, { steps: [stepOf("r", 1, 100)] });
    expect(await usage(team)).toBe(1613);
    expect(await usage(team, STORAGE_TOTAL_KEY)).toBe(1613);
  });

  it("counts letters with accents by their real size, and text as it is stored (after secrets are hidden)", async () => {
    const team = await makeTeam("bytes");
    await send(team, { steps: [{ runId: "r", index: 0, type: "tool", name: "a", input: "é".repeat(100), output: "" }] });
    expect(await usage(team)).toBe(201);
    await send(team, { steps: [{ runId: "r", index: 1, type: "tool", name: "a", input: "mail a@b.com", output: "" }] });
    expect(await usage(team)).toBe(201 + 1 + "mail [email hidden]".length);
  });

  it("does not count steps that are already saved, whether sent again alone or together with new ones", async () => {
    const team = await makeTeam("repeat-count");
    const first = { steps: [stepOf("r", 0, 300), stepOf("r", 1, 300)] };
    await send(team, first);
    expect(await usage(team)).toBe(600);
    await send(team, first);
    expect(await usage(team)).toBe(600);
    await send(team, { steps: [stepOf("r", 0, 300), stepOf("r", 2, 200)] });
    expect(await usage(team)).toBe(800);
    expect(await stepCount(team)).toBe(3);
  });

  it("counts a step once when it appears twice in the same batch", async () => {
    const team = await makeTeam("twice-in-batch");
    await send(team, { steps: [stepOf("r", 0, 400), stepOf("r", 0, 400)] });
    expect(await usage(team)).toBe(400);
  });
});

describe("the daily limit", () => {
  it("saves a batch that fits", async () => {
    const team = await makeTeam("fits");
    await setUsage(team, TODAY, DAY - 2000);
    const res = await send(team, { runs: [{ id: "r", name: "Fits" }], steps: [stepOf("r", 0, 1500)] });
    expect(res.status).toBe(200);
    expect(await usage(team)).toBe(DAY - 500);
    expect(await stepCount(team)).toBe(1);
  });

  it("accepts a batch that lands exactly on the limit, and refuses the next byte", async () => {
    const team = await makeTeam("exact");
    await setUsage(team, TODAY, DAY - 1000);
    expect((await send(team, { steps: [stepOf("r", 0, 1000)] })).status).toBe(200);
    expect(await usage(team)).toBe(DAY);
    expect((await send(team, { steps: [stepOf("r", 1, 1)] })).status).toBe(429);
  });

  it("refuses with a friendly 429 and saves nothing from that batch", async () => {
    const team = await makeTeam("over");
    await setUsage(team, TODAY, DAY - 100);
    await setUsage(team, STORAGE_TOTAL_KEY, 5000);
    const res = await send(team, { runs: [{ id: "r", name: "Too much" }], steps: [stepOf("r", 0, 40), stepOf("r", 1, 101)] });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ success: false, message: "This workspace has reached its storage limit for today." });
    // Not even the part that would have fitted, and not the run itself.
    expect(await runCount(team)).toBe(0);
    expect(await stepCount(team)).toBe(0);
    expect(await usage(team)).toBe(DAY - 100);
    expect(await usage(team, STORAGE_TOTAL_KEY)).toBe(5000);
  });

  it("does not use up the limit when a batch is sent again", async () => {
    const team = await makeTeam("repeat-limit");
    await setUsage(team, TODAY, DAY - 700);
    const batch = { runs: [{ id: "r", name: "Repeat" }], steps: [stepOf("r", 0, 700)] };
    expect((await send(team, batch)).status).toBe(200);
    expect(await usage(team)).toBe(DAY); // the workspace is now exactly full
    const again = await send(team, batch);
    expect(again.status).toBe(200);
    expect(again.body.data.newSteps).toBe(0);
    expect(await usage(team)).toBe(DAY);
    // A really new step is still refused.
    expect((await send(team, { steps: [stepOf("r", 1, 10)] })).status).toBe(429);
  });

  it("still accepts run updates that carry no new steps when the workspace is full", async () => {
    const team = await makeTeam("full-but-end");
    await setUsage(team, TODAY, DAY - 50);
    await send(team, { runs: [{ id: "r", name: "Almost done" }], steps: [stepOf("r", 0, 50)] });
    const end = await send(team, { runs: [{ id: "r", status: "ok", durationMs: 100 }] });
    expect(end.status).toBe(200);
    expect(await Run.findOne({ appId: team.appId, externalId: "r" })).toMatchObject({ status: "ok" });
  });

  it("starts a fresh count every day", async () => {
    const team = await makeTeam("new-day");
    const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await setUsage(team, yesterday, DAY);
    expect((await send(team, { steps: [stepOf("r", 0, 1000)] })).status).toBe(200);
    expect(await usage(team)).toBe(1000);
    expect(await usage(team, yesterday)).toBe(DAY);
  });

  it("holds the limit when many batches arrive at the same moment", async () => {
    const team = await makeTeam("race");
    await setUsage(team, TODAY, DAY - 5000);
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => send(team, { steps: [stepOf(`run-${index}`, 0, 1000)] })));
    const accepted = results.filter((res) => res.status === 200).length;
    expect(accepted).toBe(5);
    expect(results.filter((res) => res.status === 429)).toHaveLength(5);
    expect(await usage(team)).toBe(DAY);
    expect(await stepCount(team)).toBe(5);
  });

  it("gives every day counter an expiry so old ones tidy themselves away, but not the all-time one", async () => {
    const team = await makeTeam("expiry");
    await send(team, { steps: [stepOf("r", 0, 10)] });
    expect((await StorageUsage.findOne({ workspaceId: team.workspaceId, day: TODAY }).lean())!.expiresAt).toBeInstanceOf(Date);
    expect((await StorageUsage.findOne({ workspaceId: team.workspaceId, day: STORAGE_TOTAL_KEY }).lean())!.expiresAt).toBeUndefined();
  });
});

describe("the demo workspace", () => {
  it("has a smaller daily limit than other workspaces", async () => {
    const demo = await makeDemoTeam();
    const normal = await makeTeam("normal-vs-demo");
    // Both are 100 bytes short of the demo's limit. That is full for the demo, and plenty of room for anyone else.
    await setUsage(demo, TODAY, DEMO_DAY - 100);
    await setUsage(normal, TODAY, DEMO_DAY - 100);

    const refused = await send(demo, { steps: [stepOf("r", 0, 101)] });
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe("This workspace has reached its storage limit for today.");
    expect((await send(demo, { steps: [stepOf("r", 0, 100)] })).status).toBe(200);
    expect((await send(normal, { steps: [stepOf("r", 0, 101)] })).status).toBe(200);
  });

  it("cannot be pushed past 5 MB in one day, and the 5 MB is not shared with other workspaces", async () => {
    const demo = await makeDemoTeam();
    await setUsage(demo, TODAY, DEMO_DAY);
    expect((await send(demo, { steps: [stepOf("r", 0, 1)] })).status).toBe(429);
    const other = await makeTeam("beside-demo");
    expect((await send(other, { steps: [stepOf("r", 0, 1)] })).status).toBe(200);
  });
});

describe("the all-time limit", () => {
  it("refuses once the workspace holds 100 MB in total, and gives the day's share back", async () => {
    const team = await makeTeam("total");
    await setUsage(team, STORAGE_TOTAL_KEY, TOTAL - 100);
    await setUsage(team, TODAY, 1000);
    const res = await send(team, { steps: [stepOf("r", 0, 101)] });
    expect(res.status).toBe(429);
    expect(res.body.message).toBe("This workspace has reached its storage limit.");
    expect(await usage(team, STORAGE_TOTAL_KEY)).toBe(TOTAL - 100);
    expect(await usage(team)).toBe(1000); // not left raised by the refused batch
    expect(await stepCount(team)).toBe(0);
    // Something that still fits is fine.
    expect((await send(team, { steps: [stepOf("r", 0, 100)] })).status).toBe(200);
    expect(await usage(team, STORAGE_TOTAL_KEY)).toBe(TOTAL);
  });
});

describe("workspaces stay separate", () => {
  it("never lets one workspace's limit affect another", async () => {
    const full = await makeTeam("iso-full");
    const free = await makeTeam("iso-free");
    await setUsage(full, TODAY, DAY);
    await setUsage(full, STORAGE_TOTAL_KEY, TOTAL);

    expect((await send(full, { steps: [stepOf("r", 0, 10)] })).status).toBe(429);
    expect((await send(free, { steps: [stepOf("r", 0, 10)] })).status).toBe(200);
    expect(await usage(free)).toBe(10);
    expect(await usage(full)).toBe(DAY);
    expect(await usage(full, STORAGE_TOTAL_KEY)).toBe(TOTAL);
  });

  it("keeps two apps of the same workspace under the same limit", async () => {
    const first = await makeTeam("two-apps");
    const secondApp = await request(app)
      .post("/api/auth/login")
      .send({ email: "two-apps@storage.test.example", password: PASSWORD })
      .then((login) => request(app).post("/api/apps").set(authed(login.body.data.token)).send({ name: "Second app" }));
    const second: Team = { ...first, appId: secondApp.body.data.id, apiKey: secondApp.body.data.apiKey };
    await setUsage(first, TODAY, DAY - 100);
    expect((await send(first, { steps: [stepOf("r", 0, 100)] })).status).toBe(200);
    expect((await send(second, { steps: [stepOf("r", 0, 1)] })).status).toBe(429);
  });
});

describe("the room check itself", () => {
  it("refuses a batch bigger than the whole limit without creating any counter", async () => {
    const team = await makeTeam("too-big");
    expect(await reserveStorage(team.workspaceId as never, false, DAY + 1)).toBe("day");
    expect(await reserveStorage(team.workspaceId as never, true, DEMO_DAY + 1)).toBe("day");
    expect(await StorageUsage.countDocuments({ workspaceId: team.workspaceId })).toBe(0);
  });
});

describe("what the SDK does when the limit is reached", () => {
  it("treats the 429 as 'pause and drop': no error, nothing kept, no more requests for a while", async () => {
    const team = await makeTeam("sdk-pause");
    await setUsage(team, TODAY, DAY);

    const statuses: number[] = [];
    const viaApp: FetchLike = async (url, init) => {
      const res = await request(app).post(new URL(url).pathname).set(init.headers).send(init.body);
      statuses.push(res.status);
      return { status: res.status, headers: { get: () => null } };
    };
    const client = new AgentReplay({ apiKey: team.apiKey, baseUrl: "http://agentreplay.test", fetch: viaApp, flushIntervalMs: 60_000 });

    const run = client.startRun({ name: "Over the limit" });
    run.step({ name: "a", input: "hello" });
    run.end();
    await expect(client.flush()).resolves.toBeUndefined();
    expect(statuses).toEqual([429]);

    // Paused: later steps are dropped on the spot and nothing more is sent.
    const later = client.startRun({ name: "Later" });
    for (let index = 0; index < 20; index++) later.step({ name: `s${index}` });
    await expect(client.flush()).resolves.toBeUndefined();
    expect(statuses).toEqual([429]);
    expect((client as unknown as { transport: { queuedSteps: number } }).transport.queuedSteps).toBe(0);
    expect(await runCount(team)).toBe(0);
  });
});
