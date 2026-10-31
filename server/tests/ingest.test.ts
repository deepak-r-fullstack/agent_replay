import request from "supertest";
import { createApp } from "../src/app";
import { Run } from "../src/models/run.model";
import { Step } from "../src/models/step.model";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The SDK's front door: POST /api/ingest, end to end through the real HTTP API with a real (in-memory) MongoDB.

const app = createApp();
const PASSWORD = "a-good-password";

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

// A new team with one app, and everything a test needs to talk to the API as that app.
async function makeApp(label: string, appName = "Support bot") {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ name: "Test Person", workspaceName: `Team ${label}`, email: `${label}@ingest.test.example`, password: PASSWORD });
  const token = signup.body.data.token as string;
  const created = await request(app).post("/api/apps").set(authed(token)).send({ name: appName });
  return {
    token,
    workspaceId: signup.body.data.user.workspaceId as string,
    appId: created.body.data.id as string,
    apiKey: created.body.data.apiKey as string,
  };
}

const send = (apiKey: string, body: unknown) => request(app).post("/api/ingest").set("x-api-key", apiKey).send(body as object);
const step = (runId: string, index: number, extra: Record<string, unknown> = {}) => ({
  runId,
  index,
  type: "tool",
  name: `step ${index}`,
  input: "in",
  output: "out",
  ...extra,
});
const findRun = (appId: string, externalId: string) => Run.findOne({ appId, externalId }).lean();
const stepsOf = async (runId: unknown) => Step.find({ runId }).sort({ index: 1 }).lean();

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

describe("who may send", () => {
  let team: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    team = await makeApp("auth");
  });

  it("refuses a request with no key", async () => {
    const res = await request(app).post("/api/ingest").send({ steps: [step("r", 0)] });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/x-api-key/);
  });

  it("refuses a key that does not exist, or is not an AgentReplay key", async () => {
    expect((await send(`ar_${"0".repeat(48)}`, { steps: [step("r", 0)] })).status).toBe(401);
    expect((await send("sk-something-else", { steps: [step("r", 0)] })).status).toBe(401);
  });

  it("accepts the key as a bearer token too, and prefers x-api-key when both are sent", async () => {
    const bearer = await request(app).post("/api/ingest").set("authorization", `Bearer ${team.apiKey}`).send({ steps: [step("bearer", 0)] });
    expect(bearer.status).toBe(200);
    const both = await request(app)
      .post("/api/ingest")
      .set("x-api-key", team.apiKey)
      .set("authorization", "Bearer ar_wrong")
      .send({ steps: [step("both", 0)] });
    expect(both.status).toBe(200);
  });

  it("refuses a key that has been switched off", async () => {
    const other = await makeApp("revoked");
    expect((await send(other.apiKey, { steps: [step("r", 0)] })).status).toBe(200);
    await request(app).post(`/api/apps/${other.appId}/revoke-key`).set(authed(other.token));
    const res = await send(other.apiKey, { steps: [step("r", 1)] });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/switched off/);
  });

  it("does not accept a signed-in person's login token in place of an SDK key", async () => {
    const res = await request(app).post("/api/ingest").set("authorization", `Bearer ${team.token}`).send({ steps: [step("r", 0)] });
    expect(res.status).toBe(401);
  });
});

describe("what it accepts", () => {
  let team: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    team = await makeApp("validation");
  });

  it.each([
    ["an empty body", {}],
    ["an empty batch", { runs: [], steps: [] }],
    ["more than 500 steps", { steps: Array.from({ length: 501 }, (_, index) => step("many", index % 500)) }],
    ["more than 50 runs", { runs: Array.from({ length: 51 }, (_, index) => ({ id: `r${index}` })) }],
    ["an unknown step type", { steps: [step("r", 0, { type: "magic" })] }],
    ["a step number past the per-run limit", { steps: [step("r", 1000)] }],
    ["a negative step number", { steps: [step("r", -1)] }],
    ["a fractional step number", { steps: [step("r", 1.5)] }],
    ["a step without a run id", { steps: [{ index: 0, type: "tool" }] }],
    ["negative tokens", { steps: [step("r", 0, { tokens: -5 })] }],
    ["a bad date", { runs: [{ id: "r", startedAt: "yesterday" }] }],
    ["an unknown run status", { runs: [{ id: "r", status: "great" }] }],
    ["an over-long run id", { runs: [{ id: "x".repeat(65) }] }],
  ])("rejects %s with a friendly 400", async (_label, body) => {
    const res = await send(team.apiKey, body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("says plainly that a batch holds at most 500 steps", async () => {
    const res = await send(team.apiKey, { steps: Array.from({ length: 501 }, (_, index) => step("many", index % 500)) });
    expect(JSON.stringify(res.body.details)).toMatch(/up to 500 steps/);
  });

  it("accepts a step number at the limit, and ignores fields it does not know", async () => {
    const res = await send(team.apiKey, { steps: [step("limit", 999, { somethingNew: true })], futureField: 1 });
    expect(res.status).toBe(200);
  });

  it("rounds fractional times and token counts", async () => {
    await send(team.apiKey, { steps: [step("round", 0, { durationMs: 12.6, tokens: 9.4 })] });
    const run = await findRun(team.appId, "round");
    const [saved] = await stepsOf(run!._id);
    expect(saved).toMatchObject({ durationMs: 13, tokens: 9 });
  });

  it("answers broken JSON with a friendly 400", async () => {
    const res = await request(app).post("/api/ingest").set("x-api-key", team.apiKey).set("content-type", "application/json").send("{not json");
    expect(res.status).toBe(400);
  });

  it("takes batches bigger than the rest of the API allows, and refuses ones that are far too big", async () => {
    const big = await send(team.apiKey, { steps: [step("big", 0, { input: "x".repeat(300_000) })] });
    expect(big.status).toBe(200);
    const huge = await send(team.apiKey, { steps: [step("huge", 0, { input: "x".repeat(5_000_000) })] });
    expect(huge.status).toBe(413);
    expect(huge.body.message).toMatch(/too much data/i);
    // The rest of the API keeps its small limit.
    const login = await request(app).post("/api/auth/login").send({ email: "a@b.com", password: "x".repeat(300_000) });
    expect(login.status).toBe(413);
  });
});

describe("saving a run", () => {
  let team: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    team = await makeApp("saving");
  });

  it("saves the run, its steps and the totals", async () => {
    const res = await send(team.apiKey, {
      runs: [{ id: "refund-1", name: "Support chat", userRef: "cust_42", tags: ["refund", "vip"], status: "running", startedAt: "2026-10-31T09:00:00.000Z" }],
      steps: [
        step("refund-1", 0, { type: "retrieval", name: "find_order", tokens: 0, durationMs: 20 }),
        step("refund-1", 1, { type: "llm", name: "answer", model: "gpt-4o-mini", tokens: 100, costUsd: 0.001, durationMs: 50, error: "" }),
        step("refund-1", 2, { type: "llm", name: "polish", model: "gpt-4o", tokens: 50, costUsd: 0.0005, durationMs: 30 }),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ runs: 1, steps: 3, newSteps: 3 });

    const run = await findRun(team.appId, "refund-1");
    expect(run).toMatchObject({
      name: "Support chat",
      userRef: "cust_42",
      tags: ["refund", "vip"],
      status: "running",
      model: "gpt-4o-mini", // the first AI model used, not the last
      totalTokens: 150,
      durationMs: 100, // step times added up until the SDK reports the real total
      stepCount: 3,
      parentRunId: null,
      forkedFromStepId: null,
    });
    expect(String(run!.workspaceId)).toBe(team.workspaceId);
    expect(String(run!.appId)).toBe(team.appId);
    expect(run!.costUsd).toBeCloseTo(0.0015, 8);
    expect(run!.startedAt.toISOString()).toBe("2026-10-31T09:00:00.000Z");

    const saved = await stepsOf(run!._id);
    expect(saved.map((item) => [item.index, item.type, item.name])).toEqual([
      [0, "retrieval", "find_order"],
      [1, "llm", "answer"],
      [2, "llm", "polish"],
    ]);
  });

  it("finishes the run when the end arrives, and uses the time the SDK measured", async () => {
    await send(team.apiKey, { runs: [{ id: "refund-1", status: "ok", durationMs: 5000 }] });
    const run = await findRun(team.appId, "refund-1");
    expect(run).toMatchObject({ status: "ok", durationMs: 5000, stepCount: 3, name: "Support chat" });
  });

  it("accepts a run on its own, before it has any steps, and a run with no AI step has no model", async () => {
    await send(team.apiKey, { runs: [{ id: "only-run", name: "Just started" }] });
    expect(await findRun(team.appId, "only-run")).toMatchObject({ name: "Just started", status: "running", stepCount: 0, model: "" });
    await send(team.apiKey, { runs: [{ id: "only-run", status: "failed", durationMs: 800 }], steps: [step("only-run", 0)] });
    expect(await findRun(team.appId, "only-run")).toMatchObject({ status: "failed", durationMs: 800, model: "", stepCount: 1 });
  });

  it("accepts a start and an end of the same run in one batch", async () => {
    await send(team.apiKey, { runs: [{ id: "quick", name: "Quick" }, { id: "quick", status: "ok", durationMs: 10 }], steps: [step("quick", 0)] });
    expect(await findRun(team.appId, "quick")).toMatchObject({ name: "Quick", status: "ok" });
  });

  it("saves a run that was sent in several batches", async () => {
    await send(team.apiKey, { runs: [{ id: "multi", name: "Multi" }], steps: [step("multi", 0, { tokens: 10 })] });
    await send(team.apiKey, { steps: [step("multi", 1, { tokens: 20 }), step("multi", 2, { tokens: 30 })] });
    expect(await findRun(team.appId, "multi")).toMatchObject({ totalTokens: 60, stepCount: 3, name: "Multi" });
  });
});

describe("batches that arrive late, twice or out of order", () => {
  let team: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    team = await makeApp("order");
  });

  const batch = {
    runs: [{ id: "twice", name: "Twice", userRef: "cust_1" }],
    steps: [step("twice", 0, { tokens: 10 }), step("twice", 1, { tokens: 20 })],
  };

  it("changes nothing when the same batch is sent again", async () => {
    const first = await send(team.apiKey, batch);
    const before = await findRun(team.appId, "twice");
    const second = await send(team.apiKey, batch);
    const after = await findRun(team.appId, "twice");
    expect(first.body.data.newSteps).toBe(2);
    expect(second.status).toBe(200);
    expect(second.body.data.newSteps).toBe(0);
    expect(await Step.countDocuments({ runId: after!._id })).toBe(2);
    expect(await Run.countDocuments({ appId: team.appId, externalId: "twice" })).toBe(1);
    expect(after).toMatchObject({ totalTokens: 30, stepCount: 2, name: "Twice" });
    expect(String(after!._id)).toBe(String(before!._id));
  });

  it("never overwrites a step that was already saved", async () => {
    await send(team.apiKey, { steps: [step("twice", 0, { output: "A DIFFERENT ANSWER", tokens: 999 })] });
    const run = await findRun(team.appId, "twice");
    const [first] = await stepsOf(run!._id);
    expect(first).toMatchObject({ output: "out", tokens: 10 });
  });

  it("copes with the same batch arriving several times at the same instant", async () => {
    const same = { runs: [{ id: "race", name: "Race" }], steps: [step("race", 0), step("race", 1), step("race", 2)] };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => send(team.apiKey, same)));
    expect(results.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    const run = await findRun(team.appId, "race");
    expect(await Run.countDocuments({ appId: team.appId, externalId: "race" })).toBe(1);
    expect(await Step.countDocuments({ runId: run!._id })).toBe(3);
    expect(run).toMatchObject({ stepCount: 3, name: "Race" });
  });

  it("keeps steps that arrive before their run, and fills the run in when it arrives", async () => {
    await send(team.apiKey, { steps: [step("early", 2), step("early", 3)] });
    expect(await findRun(team.appId, "early")).toMatchObject({ name: "Untitled run", status: "running", stepCount: 2 });
    await send(team.apiKey, { runs: [{ id: "early", name: "Found it", userRef: "cust_9", startedAt: "2020-01-01T00:00:00.000Z" }], steps: [step("early", 0), step("early", 1)] });
    const run = await findRun(team.appId, "early");
    expect(run).toMatchObject({ name: "Found it", userRef: "cust_9", stepCount: 4 });
    // The real (earlier) start time replaces the placeholder's.
    expect(run!.startedAt.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect((await stepsOf(run!._id)).map((item) => item.index)).toEqual([0, 1, 2, 3]);
  });

  it("never takes a finished run back to running", async () => {
    await send(team.apiKey, { runs: [{ id: "finished", name: "Done" }], steps: [step("finished", 0)] });
    await send(team.apiKey, { runs: [{ id: "finished", status: "ok", durationMs: 100 }] });
    await send(team.apiKey, { runs: [{ id: "finished", status: "running" }] });
    expect(await findRun(team.appId, "finished")).toMatchObject({ status: "ok" });
    // ...also within one batch.
    await send(team.apiKey, { runs: [{ id: "same-batch", status: "failed" }, { id: "same-batch", status: "running" }] });
    expect(await findRun(team.appId, "same-batch")).toMatchObject({ status: "failed" });
  });

  it("keeps the earliest start time when an older batch arrives last", async () => {
    await send(team.apiKey, { runs: [{ id: "clock", startedAt: "2026-10-31T10:00:00.000Z" }] });
    await send(team.apiKey, { runs: [{ id: "clock", startedAt: "2026-10-31T09:00:00.000Z" }] });
    await send(team.apiKey, { runs: [{ id: "clock", startedAt: "2026-10-31T11:00:00.000Z" }] });
    expect((await findRun(team.appId, "clock"))!.startedAt.toISOString()).toBe("2026-10-31T09:00:00.000Z");
  });
});

describe("secrets and size", () => {
  let team: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    team = await makeApp("secrets");
  });

  it("hides secrets again on the server, even if they were sent unmasked", async () => {
    await send(team.apiKey, {
      runs: [{ id: "leaky", name: "Mail ann@example.com", userRef: "ann@example.com", tags: ["key sk-abcdefghijklmnopqrstu"] }],
      steps: [
        step("leaky", 0, {
          name: "call for ann@example.com",
          input: "card 4111 1111 1111 1111 and Authorization: Bearer abcdefghijklmnop1234567890",
          output: '{"api_key":"abc12345","mail":"ann@example.com"}',
          error: "failed with key sk-abcdefghijklmnopqrstu",
        }),
      ],
    });
    const run = await findRun(team.appId, "leaky");
    const stored = JSON.stringify([run, await stepsOf(run!._id)]);
    expect(stored).not.toMatch(/ann@example\.com|4111|abcdefghijklmnop1234567890|abc12345|sk-abcdefghijklmnopqrstu/);
    expect(stored).toContain("[email hidden]");
    expect(stored).toContain("[card hidden]");
    expect(stored).toContain("[secret hidden]");
  });

  it("cuts long text at 32 KB, and long errors at 4 KB", async () => {
    await send(team.apiKey, { steps: [step("long", 0, { input: "é".repeat(40_000), output: "y".repeat(100_000), error: "e".repeat(10_000), name: "n".repeat(500) })] });
    const run = await findRun(team.appId, "long");
    const [saved] = await stepsOf(run!._id);
    expect(Buffer.byteLength(saved.input)).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(saved.output)).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(saved.error)).toBeLessThanOrEqual(4 * 1024);
    expect(saved.input.endsWith("[cut at 32 KB]")).toBe(true);
    expect(saved.name.length).toBe(120);
  });

  it("keeps normal text exactly as it was sent", async () => {
    await send(team.apiKey, { steps: [step("plain", 0, { input: "Refund for order 1042?", output: "Your refund is ₹2,400.", model: "gpt-4o-mini" })] });
    const run = await findRun(team.appId, "plain");
    const [saved] = await stepsOf(run!._id);
    expect(saved).toMatchObject({ input: "Refund for order 1042?", output: "Your refund is ₹2,400.", model: "gpt-4o-mini" });
  });
});

describe("teams and apps stay separate", () => {
  it("keeps two teams that use the same run id apart", async () => {
    const [a, b] = await Promise.all([makeApp("iso-a"), makeApp("iso-b")]);
    await send(a.apiKey, { runs: [{ id: "shared-id", name: "A's run" }], steps: [step("shared-id", 0, { output: "A" })] });
    await send(b.apiKey, { runs: [{ id: "shared-id", name: "B's run" }], steps: [step("shared-id", 0, { output: "B" })] });
    const runA = await findRun(a.appId, "shared-id");
    const runB = await findRun(b.appId, "shared-id");
    expect(runA!.name).toBe("A's run");
    expect(runB!.name).toBe("B's run");
    expect(String(runA!.workspaceId)).toBe(a.workspaceId);
    expect(String(runB!.workspaceId)).toBe(b.workspaceId);
    expect((await stepsOf(runA!._id))[0].output).toBe("A");
    expect((await stepsOf(runB!._id))[0].output).toBe("B");
  });

  it("cannot add steps to another team's run, even by sending its run id", async () => {
    const [a, b] = await Promise.all([makeApp("steal-a"), makeApp("steal-b")]);
    await send(a.apiKey, { runs: [{ id: "private-run", name: "Private" }], steps: [step("private-run", 0, { output: "secret answer" })] });
    await send(b.apiKey, { steps: [step("private-run", 1, { output: "intruder" }), step("private-run", 0, { output: "overwrite" })] });
    const runA = await findRun(a.appId, "private-run");
    expect(runA).toMatchObject({ name: "Private", stepCount: 1 });
    expect((await stepsOf(runA!._id)).map((item) => item.output)).toEqual(["secret answer"]);
    // B only ever created its own run.
    expect(await findRun(b.appId, "private-run")).toMatchObject({ stepCount: 2 });
  });

  it("keeps two apps in the same team apart", async () => {
    const team = await makeApp("same-team", "First app");
    const second = await request(app).post("/api/apps").set(authed(team.token)).send({ name: "Second app" });
    await send(team.apiKey, { runs: [{ id: "dup", name: "From first" }] });
    await send(second.body.data.apiKey, { runs: [{ id: "dup", name: "From second" }] });
    expect(await Run.countDocuments({ workspaceId: team.workspaceId, externalId: "dup" })).toBe(2);
    expect((await findRun(team.appId, "dup"))!.name).toBe("From first");
    expect((await findRun(second.body.data.id, "dup"))!.name).toBe("From second");
  });
});
