import request from "supertest";
import { Types } from "mongoose";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { MAX_BYTES_PER_WORKSPACE_PER_DAY, MAX_TESTS_PER_WORKSPACE, MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER, MAX_TEST_OUTPUT_BYTES } from "../src/constants";
import { Run } from "../src/models/run.model";
import { StorageUsage } from "../src/models/storageUsage.model";
import { TestCase } from "../src/models/testCase.model";
import { TestResult } from "../src/models/testResult.model";
import { TestRunUsage } from "../src/models/testRunUsage.model";
import { User } from "../src/models/user.model";
import { hashPassword } from "../src/services/auth/auth.service";
import { dayKey } from "../src/services/ingest/storageQuota.service";
import * as llmClient from "../src/services/llm/llmClient";
import { runSuite } from "../src/services/tests/suite.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// Saved tests and "Run all tests", through the real HTTP API with a real (in-memory) MongoDB.

const app = createApp();
const PASSWORD = "a-good-password";
const TODAY = dayKey(new Date());
const originalEnv = { ...env };
const realCompleteChat = llmClient.completeChat;

interface Team {
  token: string;
  workspaceId: string;
  appId: string;
  apiKey: string;
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

async function teamFrom(token: string, workspaceId: string): Promise<Team> {
  const created = await request(app).post("/api/apps").set(authed(token)).send({ name: `Support bot ${Math.random()}` });
  return { token, workspaceId, appId: created.body.data.id, apiKey: created.body.data.apiKey };
}

async function makeTeam(label: string): Promise<Team> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ name: "Test Person", workspaceName: `Team ${label}`, email: `${label}@suites.test.example`, password: PASSWORD });
  return teamFrom(signup.body.data.token, signup.body.data.user.workspaceId);
}

async function makeDemoTeam(): Promise<Team> {
  const demo = await request(app).post("/api/auth/demo");
  return teamFrom(demo.body.data.token, demo.body.data.user.workspaceId);
}

async function loginAs(team: Team, email: string, role: "developer" | "viewer") {
  await User.create({ workspaceId: team.workspaceId, name: role, email, role, passwordHash: await hashPassword(PASSWORD) });
  return (await request(app).post("/api/auth/login").send({ email, password: PASSWORD })).body.data.token as string;
}

const WRONG_PROMPT = "Customer asks for a refund for order 1042. Order data: order 1041, total ₹1800.";
const RIGHT_PROMPT = "Customer asks for a refund for order 1042. Order data: order 1042, total ₹2,400.";
const chatInput = (prompt: string, model = "gpt-4o-mini") => JSON.stringify({ model, messages: [{ role: "user", content: prompt }] });

let counter = 0;
// A recorded run with one AI step asking `prompt`.
async function makeRun(team: Team, prompt = RIGHT_PROMPT) {
  counter += 1;
  const id = `suite-run-${counter}`;
  await request(app)
    .post("/api/ingest")
    .set("x-api-key", team.apiKey)
    .send({
      runs: [{ id, name: `Refund chat ${counter}`, status: "ok", durationMs: 500 }],
      steps: [
        { runId: id, index: 0, type: "retrieval", name: "find_order", input: "in", output: "out" },
        { runId: id, index: 1, type: "llm", name: "draft_answer", model: "gpt-4o-mini", input: chatInput(prompt), output: "an answer", tokens: 50 },
        { runId: id, index: 2, type: "tool", name: "send_email", input: "mail", output: "sent" },
      ],
    });
  return (await Run.findOne({ appId: team.appId, externalId: id }).lean())!;
}

const saveTest = (team: Team, body: unknown) => request(app).post("/api/tests").set(authed(team.token)).send(body as object);
const listTests = (team: Team) => request(app).get("/api/tests").set(authed(team.token));
const runAll = (team: Team, body: unknown = {}) => request(app).post("/api/tests/run").set(authed(team.token)).send(body as object);
const mustMention = (value: string) => [{ type: "contains", value }];

// A team with one saved test per prompt.
async function teamWithTests(label: string, tests: Array<{ name: string; prompt: string; checks: unknown[] }>) {
  const team = await makeTeam(label);
  for (const test of tests) {
    const run = await makeRun(team, test.prompt);
    const saved = await saveTest(team, { name: test.name, sourceRunId: String(run._id), checks: test.checks });
    expect(saved.status).toBe(201);
  }
  return team;
}

const callsToday = async (team: Team) => (await TestRunUsage.findOne({ workspaceId: team.workspaceId, day: TODAY }).lean())?.count ?? 0;
const storageToday = async (team: Team) => (await StorageUsage.findOne({ workspaceId: team.workspaceId, day: TODAY }).lean())?.bytes ?? 0;

function usePaidOpenAi(extra: Partial<typeof env> = {}) {
  Object.assign(env, { LLM_PROVIDER: "openai", LLM_API_KEY: "sk-test-not-a-real-key-1234567890", LLM_MODEL: "gpt-4.1-mini", LLM_ALLOWED_MODELS: ["gpt-4o-mini"], LLM_BASE_URL: "", ...extra });
  const bodies: Array<Record<string, any>> = [];
  const spy = jest.spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ model: "gpt-4.1-mini-2025", usage: { prompt_tokens: 1000, completion_tokens: 1000 }, choices: [{ message: { content: "Your refund is ₹2,400." } }] }) };
  }) as never);
  return { bodies, spy };
}

beforeAll(async () => {
  await startTestDb();
});

afterEach(() => {
  Object.assign(env, originalEnv);
  jest.restoreAllMocks();
});

afterAll(async () => {
  await stopTestDb();
});

describe("saving a test", () => {
  it("saves the AI step of a run with its question, its model and the checks", async () => {
    const team = await makeTeam("save");
    const run = await makeRun(team);
    const res = await saveTest(team, { name: "Refund amount", sourceRunId: String(run._id), checks: [...mustMention("₹2,400"), { type: "not_contains", value: "₹1,800" }, { type: "max_ms", value: 5000 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.test).toMatchObject({
      name: "Refund amount",
      sourceRunId: String(run._id),
      sourceStepIndex: 1, // the last AI step of the run
      model: "gpt-4o-mini",
      prompt: RIGHT_PROMPT,
      checks: [{ type: "contains", value: "₹2,400" }, { type: "not_contains", value: "₹1,800" }, { type: "max_ms", value: 5000 }],
      lastResult: null,
    });
    const stored = await TestCase.findOne({ workspaceId: team.workspaceId }).lean();
    expect(stored!.input).toBe(chatInput(RIGHT_PROMPT));
    expect(String(stored!.workspaceId)).toBe(team.workspaceId);
  });

  it("can save a chosen AI step, and refuses steps that are not AI steps", async () => {
    const team = await makeTeam("save-step");
    const run = await makeRun(team);
    expect((await saveTest(team, { name: "By number", sourceRunId: String(run._id), stepIndex: 1, checks: mustMention("x") })).status).toBe(201);
    const tool = await saveTest(team, { name: "A tool", sourceRunId: String(run._id), stepIndex: 2, checks: mustMention("x") });
    expect(tool.status).toBe(400);
    expect(tool.body.message).toMatch(/not an AI step/);
    expect((await saveTest(team, { name: "Missing", sourceRunId: String(run._id), stepIndex: 9, checks: mustMention("x") })).status).toBe(400);
  });

  it("refuses a run with no AI step, with a clear message", async () => {
    const team = await makeTeam("save-no-ai");
    const run = await Run.create({ workspaceId: team.workspaceId, appId: team.appId, name: "No AI", stepCount: 0 });
    const res = await saveTest(team, { name: "Nothing to test", sourceRunId: String(run._id), checks: mustMention("x") });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no AI step/);
  });

  it("can save a test from a fork, using the question the fork asked", async () => {
    const team = await makeTeam("save-fork");
    const run = await makeRun(team, WRONG_PROMPT);
    const fork = await request(app).post(`/api/runs/${run._id}/fork`).set(authed(team.token)).send({ fromStepIndex: 1, edits: { 1: { prompt: RIGHT_PROMPT } } });
    expect(fork.status).toBe(201);
    const res = await saveTest(team, { name: "The fixed answer", sourceRunId: fork.body.data.run.id, checks: mustMention("₹2,400") });
    expect(res.status).toBe(201);
    expect(res.body.data.test.prompt).toBe(RIGHT_PROMPT);
  });

  it.each([
    ["no name", { name: " " }],
    ["no checks", { checks: [] }],
    ["a bad check", { checks: [{ type: "contains", value: "" }] }],
    ["a run id that is not valid", { sourceRunId: "nope" }],
  ])("refuses %s with a friendly 400", async (_label, change) => {
    const team = await makeTeam(`save-bad-${_label.replace(/\W/g, "")}`);
    const run = await makeRun(team);
    const res = await saveTest(team, { name: "Test", sourceRunId: String(run._id), checks: mustMention("x"), ...change });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("refuses a name that is already used, and refuses more than 20 tests", async () => {
    const team = await makeTeam("save-limits");
    const run = await makeRun(team);
    expect((await saveTest(team, { name: "Same name", sourceRunId: String(run._id), checks: mustMention("x") })).status).toBe(201);
    const duplicate = await saveTest(team, { name: "Same name", sourceRunId: String(run._id), checks: mustMention("x") });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.message).toMatch(/already have a test with this name/);

    await TestCase.insertMany(Array.from({ length: MAX_TESTS_PER_WORKSPACE - 1 }, (_, index) => ({ workspaceId: team.workspaceId, name: `Filler ${index}`, sourceRunId: run._id, sourceStepIndex: 1, input: "q", checks: [{ type: "contains", value: "x" }] })));
    const tooMany = await saveTest(team, { name: "One too many", sourceRunId: String(run._id), checks: mustMention("x") });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toMatch(/up to 20 tests/);
  });

  it("is for owners and developers, in their own workspace only", async () => {
    const [a, b] = await Promise.all([makeTeam("save-roles-a"), makeTeam("save-roles-b")]);
    const run = await makeRun(a);
    const body = { name: "Mine", sourceRunId: String(run._id), checks: mustMention("x") };
    expect((await request(app).post("/api/tests").send(body)).status).toBe(401);
    const viewer = await loginAs(a, "look@suites.test.example", "viewer");
    const refused = await request(app).post("/api/tests").set(authed(viewer)).send(body);
    expect(refused.status).toBe(403);
    expect(await TestCase.countDocuments({ workspaceId: a.workspaceId })).toBe(0);
    const developer = await loginAs(a, "dev@suites.test.example", "developer");
    expect((await request(app).post("/api/tests").set(authed(developer)).send(body)).status).toBe(201);
    expect((await saveTest(b, body)).status).toBe(404); // another team's run
  });
});

describe("the list of tests", () => {
  it("shows a team its own tests in order of name, and what the model picker may offer", async () => {
    const team = await teamWithTests("list", [
      { name: "B test", prompt: RIGHT_PROMPT, checks: mustMention("₹2,400") },
      { name: "A test", prompt: RIGHT_PROMPT, checks: mustMention("order 1042") },
    ]);
    const other = await teamWithTests("list-other", [{ name: "Other team's test", prompt: RIGHT_PROMPT, checks: mustMention("x") }]);
    const res = await listTests(team);
    expect(res.status).toBe(200);
    expect(res.body.data.tests.map((test: { name: string }) => test.name)).toEqual(["A test", "B test"]);
    expect(res.body.data).toMatchObject({ latestSuite: null, modelChoices: ["demo-model", "demo-fast"], defaultModel: "demo-model", limits: { maxTests: 20 } });
    expect(JSON.stringify(res.body)).not.toMatch(/Other team's test|workspaceId|"input"/);
    expect((await listTests(other)).body.data.tests).toHaveLength(1);
  });

  it("lets viewers look and needs a sign-in", async () => {
    const team = await teamWithTests("list-viewer", [{ name: "A test", prompt: RIGHT_PROMPT, checks: mustMention("x") }]);
    const viewer = await loginAs(team, "look@list.test.example", "viewer");
    expect((await request(app).get("/api/tests").set(authed(viewer))).status).toBe(200);
    expect((await request(app).get("/api/tests")).status).toBe(401);
  });
});

describe("changing and deleting a test", () => {
  it("changes the name and the checks, and forgets the old result when the checks change", async () => {
    const team = await teamWithTests("edit", [{ name: "Original name", prompt: RIGHT_PROMPT, checks: mustMention("₹2,400") }]);
    await runAll(team);
    const [test] = (await listTests(team)).body.data.tests;
    expect(test.lastResult.outcome).toBe("passed");

    const renamed = await request(app).put(`/api/tests/${test.id}`).set(authed(team.token)).send({ name: "New name" });
    expect(renamed.body.data.test).toMatchObject({ name: "New name", lastResult: expect.objectContaining({ outcome: "passed" }) });

    const edited = await request(app).put(`/api/tests/${test.id}`).set(authed(team.token)).send({ checks: [{ type: "contains", value: "something else" }] });
    expect(edited.status).toBe(200);
    expect(edited.body.data.test.lastResult).toBeNull();
    // With the old result forgotten, the next run starts from "new", not from a comparison with checks that no longer exist.
    const again = await runAll(team);
    expect(again.body.data.results[0]).toMatchObject({ outcome: "failed", change: "new" });
  });

  it("refuses a name already used, a missing test, another team's test, and viewers", async () => {
    const team = await teamWithTests("edit-refuse", [
      { name: "First", prompt: RIGHT_PROMPT, checks: mustMention("x") },
      { name: "Second", prompt: RIGHT_PROMPT, checks: mustMention("x") },
    ]);
    const other = await makeTeam("edit-refuse-other");
    const [first, second] = (await listTests(team)).body.data.tests;
    const put = (token: string, id: string, body: unknown) => request(app).put(`/api/tests/${id}`).set(authed(token)).send(body as object);
    expect((await put(team.token, second.id, { name: "First" })).status).toBe(409);
    expect((await put(team.token, new Types.ObjectId().toString(), { name: "Nothing" })).status).toBe(404);
    expect((await put(team.token, "not-an-id", { name: "Nothing" })).status).toBe(404);
    expect((await put(other.token, first.id, { name: "Stolen" })).status).toBe(404);
    expect((await put(team.token, first.id, {})).status).toBe(400);
    const viewer = await loginAs(team, "look@edit.test.example", "viewer");
    expect((await put(viewer, first.id, { name: "Nope" })).status).toBe(403);
    expect((await request(app).delete(`/api/tests/${first.id}`).set(authed(viewer))).status).toBe(403);
    expect((await listTests(team)).body.data.tests.map((test: { name: string }) => test.name)).toEqual(["First", "Second"]);
  });

  it("deletes a test and its results, and nobody else's", async () => {
    const team = await teamWithTests("delete", [{ name: "Goes away", prompt: RIGHT_PROMPT, checks: mustMention("x") }]);
    const other = await makeTeam("delete-other");
    await runAll(team);
    const [test] = (await listTests(team)).body.data.tests;
    expect(await TestResult.countDocuments({ testCaseId: test.id })).toBe(1);
    expect((await request(app).delete(`/api/tests/${test.id}`).set(authed(other.token))).status).toBe(404);
    expect((await request(app).delete(`/api/tests/${test.id}`).set(authed(team.token))).status).toBe(200);
    expect(await TestResult.countDocuments({ testCaseId: test.id })).toBe(0);
    expect((await listTests(team)).body.data.tests).toEqual([]);
    expect((await request(app).delete(`/api/tests/${test.id}`).set(authed(team.token))).status).toBe(404);
  });
});

describe("running all tests", () => {
  it("says so when there is nothing to run", async () => {
    const team = await makeTeam("run-empty");
    const res = await runAll(team);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no tests yet/);
  });

  it("asks every test's question, checks the answers and saves the results", async () => {
    const team = await teamWithTests("run-basic", [
      { name: "Right amount", prompt: RIGHT_PROMPT, checks: [...mustMention("₹2,400"), { type: "not_contains", value: "₹1,800" }] },
      { name: "Wrong data in", prompt: WRONG_PROMPT, checks: mustMention("₹2,400") },
    ]);
    const res = await runAll(team);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toEqual({ total: 2, improved: 0, same: 0, worse: 0, new: 2, notRun: 0 });
    const byName = Object.fromEntries(res.body.data.results.map((item: { name: string }) => [item.name, item]));
    expect(byName["Right amount"]).toMatchObject({ outcome: "passed", change: "new", failedChecks: [], model: "gpt-4o-mini" });
    expect(byName["Wrong data in"]).toMatchObject({ outcome: "failed", change: "new" });
    expect(byName["Wrong data in"].failedChecks[0].message).toBe('The answer should mention "₹2,400", but it does not.');

    const tests = (await listTests(team)).body.data;
    expect(tests.latestSuite).toMatchObject({ total: 2, new: 2, worse: 0, improved: 0 });
    const right = tests.tests.find((test: { name: string }) => test.name === "Right amount");
    expect(right.lastResult).toMatchObject({ outcome: "passed", change: "new", costUsd: 0, model: "gpt-4o-mini" });
    expect(right.lastResult.output).toContain("order 1042 is ₹2,400");
    expect(await TestResult.countDocuments({ workspaceId: team.workspaceId })).toBe(2);
  });

  it("says nothing changed when nothing did", async () => {
    const team = await teamWithTests("run-same", [
      { name: "Passes", prompt: RIGHT_PROMPT, checks: mustMention("₹2,400") },
      { name: "Fails", prompt: WRONG_PROMPT, checks: mustMention("₹2,400") },
    ]);
    await runAll(team);
    const second = await runAll(team);
    expect(second.body.data.summary).toEqual({ total: 2, improved: 0, same: 2, worse: 0, new: 0, notRun: 0 });
  });

  it("shows a test going from green to red when the model gets worse, and back to green when it gets better", async () => {
    const team = await teamWithTests("run-worse", [
      { name: "Refund amount", prompt: RIGHT_PROMPT, checks: [...mustMention("₹2,400"), { type: "not_contains", value: "₹1,800" }] },
      { name: "Mentions the order", prompt: RIGHT_PROMPT, checks: mustMention("order 1042") },
    ]);
    const first = await runAll(team);
    expect(first.body.data.summary).toMatchObject({ new: 2, worse: 0 });

    // The cheaper free demo model misreads the amount: one test turns red, the other still passes.
    const cheaper = await runAll(team, { model: "demo-fast" });
    expect(cheaper.body.data.summary).toEqual({ total: 2, improved: 0, same: 1, worse: 1, new: 0, notRun: 0 });
    const worse = cheaper.body.data.results.find((item: { change: string }) => item.change === "worse");
    expect(worse).toMatchObject({ name: "Refund amount", outcome: "failed", model: "demo-fast" });
    expect(worse.failedChecks.map((item: { message: string }) => item.message)).toEqual([
      'The answer should mention "₹2,400", but it does not.',
      'The answer should not mention "₹1,800", but it does.',
    ]);
    expect((await listTests(team)).body.data.latestSuite).toMatchObject({ worse: 1, same: 1, improved: 0, model: "demo-fast" });

    const back = await runAll(team);
    expect(back.body.data.summary).toEqual({ total: 2, improved: 1, same: 1, worse: 0, new: 0, notRun: 0 });
    expect(back.body.data.results.find((item: { change: string }) => item.change === "improved")).toMatchObject({ name: "Refund amount", outcome: "passed" });
  });

  it("only lets a model from the picker be chosen", async () => {
    const team = await teamWithTests("run-model", [{ name: "A test", prompt: RIGHT_PROMPT, checks: mustMention("x") }]);
    const refused = await runAll(team, { model: "gpt-4o" });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/not available here/);
    expect(await TestResult.countDocuments({ workspaceId: team.workspaceId })).toBe(0);
    expect(await callsToday(team)).toBe(0);
    expect((await runAll(team, { model: "demo-fast" })).status).toBe(200);
  });

  it("is for owners and developers, and each team runs only its own tests", async () => {
    const [a, b] = await Promise.all([
      teamWithTests("run-roles-a", [{ name: "A's test", prompt: RIGHT_PROMPT, checks: mustMention("x") }]),
      teamWithTests("run-roles-b", [{ name: "B's test", prompt: RIGHT_PROMPT, checks: mustMention("x") }]),
    ]);
    expect((await request(app).post("/api/tests/run").send({})).status).toBe(401);
    const viewer = await loginAs(a, "look@run.test.example", "viewer");
    expect((await request(app).post("/api/tests/run").set(authed(viewer)).send({})).status).toBe(403);
    expect(await TestResult.countDocuments({ workspaceId: a.workspaceId })).toBe(0);
    const ranA = await runAll(a);
    expect(ranA.body.data.results.map((item: { name: string }) => item.name)).toEqual(["A's test"]);
    expect(await TestResult.countDocuments({ workspaceId: b.workspaceId })).toBe(0);
  });

  it("keeps a short, masked copy of each answer, while the checks look at the whole answer", async () => {
    const team = await teamWithTests("run-output", [{ name: "Long answer", prompt: RIGHT_PROMPT, checks: mustMention("the very last words") }]);
    const longAnswer = `${"Mail ann@example.com. ".repeat(500)} the very last words`;
    jest.spyOn(llmClient, "completeChat").mockResolvedValue({ text: longAnswer, model: "demo-model", inputTokens: 1, outputTokens: 1 });
    const res = await runAll(team);
    expect(res.body.data.results[0].outcome).toBe("passed"); // the words at the end were found
    const [result] = await TestResult.find({ workspaceId: team.workspaceId }).lean();
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(MAX_TEST_OUTPUT_BYTES);
    expect(result.output).not.toContain("ann@example.com");
    expect(result.output).toContain("[email hidden]");
  });

  it("works out cost from the prices in the settings, so a 'costs no more than' check can fail", async () => {
    const team = await teamWithTests("run-cost", [{ name: "Cheap enough", prompt: RIGHT_PROMPT, checks: [...mustMention("₹2,400"), { type: "max_cost", value: 0.001 }] }]);
    usePaidOpenAi({ LLM_INPUT_PRICE_PER_MILLION: 1, LLM_OUTPUT_PRICE_PER_MILLION: 3 }); // 1000 in + 1000 out = $0.004
    const res = await runAll(team);
    expect(res.body.data.results[0]).toMatchObject({ outcome: "failed" });
    expect(res.body.data.results[0].failedChecks[0].message).toBe("The answer cost $0.0040, but it should cost no more than $0.0010.");
    const [test] = (await listTests(team)).body.data.tests;
    expect(test.lastResult.costUsd).toBeCloseTo(0.004, 8);
  });
});

describe("a test run is held to the cost limits", () => {
  it("never reaches a paid provider for the demo workspace, whatever is set up", async () => {
    const demo = await makeDemoTeam();
    const run = await makeRun(demo);
    await saveTest(demo, { name: `Demo test ${Math.random()}`, sourceRunId: String(run._id), checks: mustMention("order 1042") });
    const { spy } = usePaidOpenAi();
    const res = await runAll(demo);
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(res.body.data.results.every((item: { outcome: string; model: string }) => item.outcome === "passed" && item.model === "gpt-4o-mini")).toBe(true);
    expect((await listTests(demo)).body.data.modelChoices).toEqual(["demo-model", "demo-fast"]); // the demo's picker offers only the free models
  });

  it("uses only allowed models and caps every answer for an ordinary workspace", async () => {
    const team = await teamWithTests("limits-model", [{ name: "One test", prompt: RIGHT_PROMPT, checks: mustMention("₹2,400") }]);
    const { bodies } = usePaidOpenAi({ LLM_ALLOWED_MODELS: ["gpt-4o-mini", "gpt-4.1-mini"] });
    expect((await listTests(team)).body.data.modelChoices.sort()).toEqual(["gpt-4.1-mini", "gpt-4o-mini"]);
    expect((await runAll(team)).status).toBe(200); // the test's own model, gpt-4o-mini, is on the list
    expect((await runAll(team, { model: "gpt-4.1-mini" })).status).toBe(200);
    expect(bodies.map((body) => body.model)).toEqual(["gpt-4o-mini", "gpt-4.1-mini"]);
    expect(bodies.every((body) => body.max_completion_tokens === 1500)).toBe(true);
  });

  it("replaces the test's own model when it is not allowed, and the result says so", async () => {
    const team = await teamWithTests("limits-replace", [{ name: "Old model", prompt: RIGHT_PROMPT, checks: mustMention("₹2,400") }]);
    const { bodies } = usePaidOpenAi({ LLM_ALLOWED_MODELS: [] });
    const res = await runAll(team);
    expect(bodies[0].model).toBe("gpt-4.1-mini");
    expect(res.body.data.results[0].note).toBe("Used gpt-4.1-mini instead of gpt-4o-mini, which is not allowed here.");
  });

  it("has a daily limit of AI calls for test runs, and refuses a whole run that would go over it, saving nothing", async () => {
    const team = await teamWithTests("limits-daily", [
      { name: "One", prompt: RIGHT_PROMPT, checks: mustMention("x") },
      { name: "Two", prompt: RIGHT_PROMPT, checks: mustMention("x") },
    ]);
    await TestRunUsage.updateOne({ workspaceId: team.workspaceId, day: TODAY }, { $set: { count: MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER - 1 } }, { upsert: true });
    const ask = jest.spyOn(llmClient, "completeChat");
    const storageBefore = await storageToday(team);
    const refused = await runAll(team); // two calls, one left
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe("This workspace has used today's test runs. Try again tomorrow.");
    expect(ask).not.toHaveBeenCalled();
    expect(await TestResult.countDocuments({ workspaceId: team.workspaceId })).toBe(0);
    expect(await callsToday(team)).toBe(MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER - 1);
    expect(await storageToday(team)).toBe(storageBefore);

    await TestRunUsage.updateOne({ workspaceId: team.workspaceId, day: TODAY }, { $set: { count: MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER - 2 } });
    expect((await runAll(team)).status).toBe(200); // exactly enough room
    expect(await callsToday(team)).toBe(MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER);
  });

  it("counts each workspace's test runs on its own, and starts again every day", async () => {
    const full = await teamWithTests("limits-full", [{ name: "One", prompt: RIGHT_PROMPT, checks: mustMention("x") }]);
    const free = await teamWithTests("limits-free", [{ name: "One", prompt: RIGHT_PROMPT, checks: mustMention("x") }]);
    await TestRunUsage.updateOne({ workspaceId: full.workspaceId, day: TODAY }, { $set: { count: MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER } }, { upsert: true });
    expect((await runAll(full)).status).toBe(429);
    expect((await runAll(free)).status).toBe(200);

    const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const tomorrowTeam = await teamWithTests("limits-newday", [{ name: "One", prompt: RIGHT_PROMPT, checks: mustMention("x") }]);
    await TestRunUsage.updateOne({ workspaceId: tomorrowTeam.workspaceId, day: yesterday }, { $set: { count: MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER } }, { upsert: true });
    expect((await runAll(tomorrowTeam)).status).toBe(200);
  });

  it("counts the room the results will use against the storage limit, and refuses before asking the AI when there is none", async () => {
    const team = await teamWithTests("limits-storage", [{ name: "One", prompt: RIGHT_PROMPT, checks: mustMention("x") }]);
    const before = await storageToday(team);
    expect((await runAll(team)).status).toBe(200);
    expect(await storageToday(team)).toBe(before + MAX_TEST_OUTPUT_BYTES);

    await StorageUsage.updateOne({ workspaceId: team.workspaceId, day: TODAY }, { $set: { bytes: MAX_BYTES_PER_WORKSPACE_PER_DAY - 10 } });
    const calls = await callsToday(team);
    const ask = jest.spyOn(llmClient, "completeChat");
    const full = await runAll(team);
    expect(full.status).toBe(429);
    expect(full.body.message).toBe("This workspace has reached its storage limit for today.");
    expect(ask).not.toHaveBeenCalled();
    expect(await callsToday(team)).toBe(calls); // the reserved calls were given back
  });
});

describe("when something goes wrong while running", () => {
  it("says a test could not be run when the AI cannot be reached, without calling it a failure, and keeps what it is compared with", async () => {
    const team = await teamWithTests("wrong-ai", [
      { name: "Fine test", prompt: RIGHT_PROMPT, checks: mustMention("₹2,400") },
      { name: "Unlucky test", prompt: "UNLUCKY question", checks: mustMention("anything") },
    ]);
    const first = await runAll(team);
    expect(first.body.data.results.find((item: { name: string }) => item.name === "Unlucky test").outcome).toBe("failed");

    jest.spyOn(llmClient, "completeChat").mockImplementation(async (request, options) => {
      if (request.messages.some((message) => message.content.includes("UNLUCKY"))) throw new (await import("../src/helpers/errors")).ServiceUnavailableError("Could not reach the AI service. Check the AI settings and try again.");
      return realCompleteChat(request, options);
    });
    const second = await runAll(team);
    expect(second.body.data.summary).toEqual({ total: 2, improved: 0, same: 1, worse: 0, new: 0, notRun: 1 });
    expect(second.body.data.results.find((item: { name: string }) => item.name === "Unlucky test")).toMatchObject({ outcome: "error", change: "not_run", error: "Could not reach the AI service. Check the AI settings and try again." });
    const unlucky = (await listTests(team)).body.data.tests.find((test: { name: string }) => test.name === "Unlucky test");
    expect(unlucky.lastResult).toMatchObject({ outcome: "error" });

    // Once the AI is back, the test is compared with the last time it was really checked (it failed), not treated as new.
    jest.restoreAllMocks();
    const third = await runAll(team);
    expect(third.body.data.results.find((item: { name: string }) => item.name === "Unlucky test")).toMatchObject({ outcome: "failed", change: "same" });
  });

  it("asks only a few tests at a time", async () => {
    const team = await makeTeam("wrong-concurrency");
    const run = await makeRun(team);
    await TestCase.insertMany(Array.from({ length: 12 }, (_, index) => ({ workspaceId: team.workspaceId, name: `Test ${index}`, sourceRunId: run._id, sourceStepIndex: 1, input: "question", model: "demo-model", checks: [{ type: "contains", value: "answer" }] })));
    let active = 0;
    let mostAtOnce = 0;
    const ask = async (request: llmClient.ChatRequest) => {
      active += 1;
      mostAtOnce = Math.max(mostAtOnce, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { text: "an answer", model: request.model, inputTokens: 1, outputTokens: 1 };
    };
    const result = await runSuite(new Types.ObjectId(team.workspaceId), {}, ask);
    expect(result.summary.total).toBe(12);
    expect(mostAtOnce).toBe(5);
  });

  it("stops one AI call that takes too long, and says so for that test only", async () => {
    const team = await makeTeam("wrong-call-time");
    const run = await makeRun(team);
    await TestCase.insertMany([
      { workspaceId: team.workspaceId, name: "Slow test", sourceRunId: run._id, sourceStepIndex: 1, input: "SLOW", model: "demo-model", checks: [{ type: "contains", value: "answer" }] },
      { workspaceId: team.workspaceId, name: "Quick test", sourceRunId: run._id, sourceStepIndex: 1, input: "quick", model: "demo-model", checks: [{ type: "contains", value: "answer" }] },
    ]);
    const ask = (request: llmClient.ChatRequest) => (request.messages[0].content === "SLOW" ? new Promise<never>(() => undefined) : Promise.resolve({ text: "an answer", model: request.model, inputTokens: 1, outputTokens: 1 }));
    const result = await runSuite(new Types.ObjectId(team.workspaceId), {}, ask, { callMs: 80, suiteMs: 10_000 });
    const byName = Object.fromEntries(result.results.map((item) => [item.name, item]));
    expect(byName["Slow test"]).toMatchObject({ outcome: "error", change: "not_run" });
    expect(byName["Slow test"].error).toMatch(/took too long to answer/);
    expect(byName["Quick test"]).toMatchObject({ outcome: "passed", change: "new" });
  });

  it("stops a whole run that takes too long: nothing is saved as passed, and the room of tests that were never asked is given back", async () => {
    const team = await makeTeam("wrong-suite-time");
    const run = await makeRun(team);
    await TestCase.insertMany(Array.from({ length: 6 }, (_, index) => ({ workspaceId: team.workspaceId, name: `Test ${index}`, sourceRunId: run._id, sourceStepIndex: 1, input: "question", model: "demo-model", checks: [{ type: "contains", value: "answer" }] })));
    const storageBefore = await storageToday(team);
    const never = () => new Promise<never>(() => undefined);
    const started = Date.now();
    const result = await runSuite(new Types.ObjectId(team.workspaceId), {}, never, { callMs: 1000, suiteMs: 300 });
    expect(Date.now() - started).toBeLessThan(2000); // it stopped; it did not wait for calls that never answer
    expect(result.summary).toMatchObject({ total: 6, notRun: 6, improved: 0, same: 0, worse: 0, new: 0 });
    // Five tests were in progress when time ran out. The sixth was either never asked, or started with only a moment left
    // and was stopped: both are fine, and neither is ever a pass.
    const errors = result.results.filter((item) => item.outcome === "error");
    const notAsked = result.results.filter((item) => item.outcome === "skipped");
    expect(errors.length + notAsked.length).toBe(6);
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.every((item) => /took too long to answer/.test(item.error))).toBe(true);
    // Only tests that were asked keep their share of today's AI calls and of the storage room.
    expect(await callsToday(team)).toBe(6 - notAsked.length);
    expect(await storageToday(team)).toBe(storageBefore + (6 - notAsked.length) * MAX_TEST_OUTPUT_BYTES);
  });

  it("asks nothing when there is no time left, and gives all of its room back", async () => {
    const team = await makeTeam("wrong-no-time");
    const run = await makeRun(team);
    await TestCase.insertMany(Array.from({ length: 3 }, (_, index) => ({ workspaceId: team.workspaceId, name: `Test ${index}`, sourceRunId: run._id, sourceStepIndex: 1, input: "question", model: "demo-model", checks: [{ type: "contains", value: "answer" }] })));
    const storageBefore = await storageToday(team);
    const ask = jest.fn(async (request: llmClient.ChatRequest) => ({ text: "an answer", model: request.model, inputTokens: 1, outputTokens: 1 }));
    const result = await runSuite(new Types.ObjectId(team.workspaceId), {}, ask, { callMs: 1000, suiteMs: 0 });
    expect(ask).not.toHaveBeenCalled();
    expect(result.results.every((item) => item.outcome === "skipped" && item.change === "not_run")).toBe(true);
    expect(result.results[0].error).toMatch(/ran out before this one was asked/);
    expect(result.summary).toMatchObject({ total: 3, notRun: 3 });
    expect(await callsToday(team)).toBe(0);
    expect(await storageToday(team)).toBe(storageBefore);
    // Skipped tests are not failures: nothing is marked as passed or failed.
    const tests = (await listTests(team)).body.data.tests;
    expect(tests.every((test: { lastResult: { outcome: string } }) => test.lastResult.outcome === "skipped")).toBe(true);
  });
});
