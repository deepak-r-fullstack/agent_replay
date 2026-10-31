import request from "supertest";
import { Types } from "mongoose";
import { createApp } from "../src/app";
import { MAX_LLM_STEPS_PER_FORK, MAX_BYTES_PER_WORKSPACE_PER_DAY, RUN_STORAGE_BYTES } from "../src/constants";
import { ServiceUnavailableError } from "../src/helpers/errors";
import { Run } from "../src/models/run.model";
import { StorageUsage } from "../src/models/storageUsage.model";
import { Step } from "../src/models/step.model";
import { User } from "../src/models/user.model";
import { hashPassword } from "../src/services/auth/auth.service";
import { forkRun } from "../src/services/forks/fork.service";
import { dayKey } from "../src/services/ingest/storageQuota.service";
import * as llmClient from "../src/services/llm/llmClient";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// Forks end to end: a fork is a NEW run; AI steps are asked again, tools never run, the original never changes.
// Everything goes through the real HTTP API with a real (in-memory) MongoDB.

const app = createApp();
const PASSWORD = "a-good-password";

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
    .send({ name: "Test Person", workspaceName: `Team ${label}`, email: `${label}@fork.test.example`, password: PASSWORD });
  const token = signup.body.data.token as string;
  const created = await request(app).post("/api/apps").set(authed(token)).send({ name: "Support bot" });
  return { token, workspaceId: signup.body.data.user.workspaceId, appId: created.body.data.id, apiKey: created.body.data.apiKey };
}

async function loginAs(team: Team, email: string, role: "developer" | "viewer") {
  await User.create({ workspaceId: team.workspaceId, name: role, email, role, passwordHash: await hashPassword(PASSWORD) });
  const login = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  return login.body.data.token as string;
}

const ingest = (team: Team, body: unknown) => request(app).post("/api/ingest").set("x-api-key", team.apiKey).send(body as object);
const fork = (token: string, runId: string | Types.ObjectId, body: unknown) => request(app).post(`/api/runs/${runId}/fork`).set(authed(token)).send(body as object);
const compare = (token: string, forkId: string | Types.ObjectId) => request(app).get(`/api/runs/${forkId}/compare`).set(authed(token));

// The refund story: the agent looked up order 1041 (Rs 1,800) when the customer asked about order 1042 (Rs 2,400).
const WRONG_ANSWER = "Your refund for order 1041 is ₹1,800. It will reach your original payment method in 3 to 5 working days. Is there anything else I can help with?";
const FIXED_ANSWER = "Your refund for order 1042 is ₹2,400. It will reach your original payment method in 3 to 5 working days. Is there anything else I can help with?";
const WRONG_PROMPT = "Customer asks for a refund for order 1042. Order data: order 1041, total ₹1800.";
const RIGHT_PROMPT = "Customer asks for a refund for order 1042. Order data: order 1042, total ₹2,400.";

let storyCounter = 0;
async function makeStory(team: Team, extra: Record<string, unknown> = {}) {
  storyCounter += 1;
  const id = `story-${storyCounter}`;
  await ingest(team, {
    runs: [{ id, name: "Refund chat", userRef: "customer-1", tags: ["refund"], status: "ok", durationMs: 3000 }],
    steps: [
      { runId: id, index: 0, type: "retrieval", name: "find_order", input: '{"customer":"customer-1"}', output: '{"orderId":"1041","total":1800}', durationMs: 40 },
      {
        runId: id,
        index: 1,
        type: "llm",
        name: "draft_answer",
        model: "gpt-4o-mini",
        input: JSON.stringify({ model: "gpt-4o-mini", system: "You are a polite support agent.", messages: [{ role: "user", content: WRONG_PROMPT }] }),
        output: WRONG_ANSWER,
        tokens: 180,
        costUsd: 0.0004,
        durationMs: 650,
      },
      {
        runId: id,
        index: 2,
        type: "tool",
        name: "issue_refund",
        input: '{"orderId":"1041","amount":1800}',
        output: '{"status":"refunded","amount":1800}',
        durationMs: 60,
        externalRef: { system: "agentguard", id: "act_1", url: "https://agentguard.example.com/activity/act_1" },
      },
      { runId: id, index: 3, type: "tool", name: "send_email", input: `Email body: ${WRONG_ANSWER}`, output: "sent", durationMs: 30 },
      ...((extra.steps as unknown[]) ?? []),
    ],
  });
  return (await Run.findOne({ appId: team.appId, externalId: id }).lean())!;
}

const stepsOf = (runId: Types.ObjectId | string) => Step.find({ runId }).sort({ index: 1 }).lean();
const fix = { fromStepIndex: 1, edits: { 1: { prompt: RIGHT_PROMPT } } };

beforeAll(async () => {
  await startTestDb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await stopTestDb();
});

describe("who may fork", () => {
  it("needs a signed-in person", async () => {
    const team = await makeTeam("anon");
    const run = await makeStory(team);
    expect((await request(app).post(`/api/runs/${run._id}/fork`).send(fix)).status).toBe(401);
  });

  it("lets owners and developers fork, and refuses viewers without saving anything", async () => {
    const team = await makeTeam("roles");
    const run = await makeStory(team);
    const developer = await loginAs(team, "dev@fork.test.example", "developer");
    const viewer = await loginAs(team, "look@fork.test.example", "viewer");
    const runsBefore = await Run.countDocuments({ appId: team.appId });

    expect((await fork(team.token, run._id, fix)).status).toBe(201);
    expect((await fork(developer, run._id, fix)).status).toBe(201);
    const refused = await fork(viewer, run._id, fix);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/can only look/i);
    expect(await Run.countDocuments({ appId: team.appId })).toBe(runsBefore + 2);
  });

  it("does not let another team fork your run, and answers 404 for runs that do not exist", async () => {
    const [a, b] = await Promise.all([makeTeam("iso-a"), makeTeam("iso-b")]);
    const run = await makeStory(a);
    const stolen = await fork(b.token, run._id, fix);
    expect(stolen.status).toBe(404);
    expect(await Run.countDocuments({ parentRunId: run._id })).toBe(0);
    expect((await fork(a.token, new Types.ObjectId(), fix)).status).toBe(404);
    expect((await fork(a.token, "not-an-id", fix)).status).toBe(404);
  });
});

describe("what a fork is", () => {
  it("is a new run that points back to its original and the step it started from", async () => {
    const team = await makeTeam("shape");
    const original = await makeStory(team);
    const res = await fork(team.token, original._id, fix);
    expect(res.status).toBe(201);
    const forkRunDoc = await Run.findById(res.body.data.run.id).lean();
    const originalStep = (await stepsOf(original._id))[1];
    expect(res.body.data.run).toMatchObject({ name: "Refund chat (fork)", status: "ok", stepCount: 4, parentRunId: String(original._id), forkedFromStepId: String(originalStep._id), userRef: "customer-1", tags: ["refund"] });
    expect(forkRunDoc).toMatchObject({ workspaceId: original.workspaceId, appId: original.appId });
    expect(forkRunDoc!.externalId).toBeUndefined();
    expect(String(forkRunDoc!._id)).not.toBe(String(original._id));
  });

  it("copies the steps before the fork point exactly, asks the AI step again, and reuses the tools", async () => {
    const team = await makeTeam("steps");
    const original = await makeStory(team);
    const res = await fork(team.token, original._id, fix);
    const [copied, asked, refund, email] = await stepsOf(res.body.data.run.id);
    const [originalFirst] = await stepsOf(original._id);

    // before the fork point: copied
    expect(copied).toMatchObject({ index: 0, origin: "copied", type: "retrieval", name: "find_order", input: originalFirst.input, output: originalFirst.output, durationMs: 40 });
    // the fork point: asked again through the AI model, with the changed prompt
    expect(asked).toMatchObject({ index: 1, origin: "rerun", type: "llm", name: "draft_answer", model: "gpt-4o-mini", output: FIXED_ANSWER, error: "" });
    expect(asked.input).toContain("order 1042, total ₹2,400");
    expect(asked.input).toContain("You are a polite support agent."); // the rest of what the AI was asked is kept
    expect(asked.tokens).toBeGreaterThan(0);
    // tools: never run, recorded result reused
    expect(refund).toMatchObject({ index: 2, origin: "simulated", type: "tool", output: '{"status":"refunded","amount":1800}', error: "" });
    expect(email).toMatchObject({ index: 3, origin: "simulated", output: "sent" });
  });

  it("puts the new answer into later steps that quoted the old one word for word", async () => {
    const team = await makeTeam("flows");
    const original = await makeStory(team);
    const res = await fork(team.token, original._id, fix);
    const steps = await stepsOf(res.body.data.run.id);
    expect(steps[3].input).toBe(`Email body: ${FIXED_ANSWER}`);
    expect(steps[3].input).not.toContain("1041");
  });

  it("does not link a step that did not really happen to the real action, but keeps links on copied steps", async () => {
    const team = await makeTeam("links");
    const original = await makeStory(team);
    const copiedFork = await fork(team.token, original._id, { fromStepIndex: 3, edits: {} });
    const simulatedFork = await fork(team.token, original._id, { fromStepIndex: 1, edits: {} });
    expect((await stepsOf(copiedFork.body.data.run.id))[2].externalRef).toMatchObject({ system: "agentguard", id: "act_1" });
    expect((await stepsOf(simulatedFork.body.data.run.id))[2].externalRef).toBeUndefined();
  });

  it("changes nothing in the original run or its steps", async () => {
    const team = await makeTeam("original-safe");
    const original = await makeStory(team);
    const before = JSON.stringify({ run: await Run.findById(original._id).lean(), steps: await stepsOf(original._id) });
    await fork(team.token, original._id, fix);
    await fork(team.token, original._id, { fromStepIndex: 2, edits: { 2: { output: '{"status":"refunded","amount":2400}' } } });
    await fork(team.token, original._id, { fromStepIndex: 0, edits: {} });
    const after = JSON.stringify({ run: await Run.findById(original._id).lean(), steps: await stepsOf(original._id) });
    expect(after).toBe(before);
  });

  it("asks an unchanged AI step again when nothing is edited (the demo model answers the same way)", async () => {
    const team = await makeTeam("no-edit");
    const original = await makeStory(team);
    const res = await fork(team.token, original._id, { fromStepIndex: 1, edits: {} });
    expect(res.status).toBe(201);
    expect((await stepsOf(res.body.data.run.id))[1]).toMatchObject({ origin: "rerun", output: WRONG_ANSWER });
  });

  it("uses a different model when a person chooses one", async () => {
    const team = await makeTeam("model");
    const original = await makeStory(team);
    const res = await fork(team.token, original._id, { fromStepIndex: 1, edits: { 1: { model: "claude-haiku-4-5" } } });
    const [, asked] = await stepsOf(res.body.data.run.id);
    expect(asked.model).toBe("claude-haiku-4-5");
    expect(res.body.data.run.model).toBe("claude-haiku-4-5");
  });

  it("can start from a tool step: the hand-typed result is used, a recorded failure is not carried over, and later AI steps are asked again", async () => {
    const team = await makeTeam("tool-edit");
    const original = await makeStory(team, {
      steps: [
        { runId: `story-${storyCounter + 1}`, index: 4, type: "llm", name: "summarise", model: "gpt-4o-mini", input: "Please summarise this chat.", output: "old summary", durationMs: 10 },
      ],
    });
    // Make the refund tool step a recorded failure.
    const refund = (await stepsOf(original._id))[2];
    await Step.updateOne({ _id: refund._id }, { $set: { error: "Error: refund service timed out", output: "" } });

    const unchanged = await fork(team.token, original._id, { fromStepIndex: 2, edits: {} });
    expect(unchanged.body.data.run.status).toBe("failed"); // the recorded failure is reused as it was
    expect((await stepsOf(unchanged.body.data.run.id))[2]).toMatchObject({ origin: "simulated", error: "Error: refund service timed out" });

    const fixed = await fork(team.token, original._id, { fromStepIndex: 2, edits: { 2: { output: '{"status":"refunded","amount":2400}' } } });
    const steps = await stepsOf(fixed.body.data.run.id);
    expect(fixed.body.data.run.status).toBe("ok");
    expect(steps[2]).toMatchObject({ origin: "edited", output: '{"status":"refunded","amount":2400}', error: "" });
    expect(steps[4]).toMatchObject({ origin: "rerun", type: "llm" }); // later AI steps are asked again
    expect(steps[0].origin).toBe("copied");
    expect(steps[1].origin).toBe("copied");
  });

  it("can start from the first or the last step, and can be made from another fork", async () => {
    const team = await makeTeam("edges");
    const original = await makeStory(team);
    const first = await fork(team.token, original._id, { fromStepIndex: 0, edits: {} });
    expect((await stepsOf(first.body.data.run.id)).map((step) => step.origin)).toEqual(["simulated", "rerun", "simulated", "simulated"]);
    const last = await fork(team.token, original._id, { fromStepIndex: 3, edits: {} });
    expect((await stepsOf(last.body.data.run.id)).map((step) => step.origin)).toEqual(["copied", "copied", "copied", "simulated"]);
    const second = await fork(team.token, first.body.data.run.id, { fromStepIndex: 1, edits: { 1: { prompt: RIGHT_PROMPT } } });
    expect(second.status).toBe(201);
    expect(second.body.data.run.parentRunId).toBe(first.body.data.run.id);
  });

  it("keeps the step numbers of a run that has gaps in them", async () => {
    const team = await makeTeam("gaps");
    const run = await Run.create({ workspaceId: team.workspaceId, appId: team.appId, name: "Gappy", stepCount: 3 });
    await Step.insertMany([0, 2, 5].map((index) => ({ runId: run._id, index, type: "tool", name: `step ${index}`, input: "in", output: "out" })));
    const res = await fork(team.token, run._id, { fromStepIndex: 2, edits: {} });
    expect((await stepsOf(res.body.data.run.id)).map((step) => [step.index, step.origin])).toEqual([[0, "copied"], [2, "simulated"], [5, "simulated"]]);
  });

  it("hides secrets in what a person typed and in what the AI answered", async () => {
    const team = await makeTeam("masking");
    const original = await makeStory(team);
    jest.spyOn(llmClient, "completeChat").mockResolvedValueOnce({ text: "Mail ann@example.com and use sk-abcdefghijklmnopqrstu", model: "m", inputTokens: 1, outputTokens: 1 });
    const res = await fork(team.token, original._id, {
      fromStepIndex: 1,
      edits: { 1: { prompt: "My card is 4111 1111 1111 1111" }, 2: { output: "sent to bob@example.com" } },
    });
    expect(res.status).toBe(201);
    const stored = JSON.stringify(await stepsOf(res.body.data.run.id));
    expect(stored).not.toMatch(/ann@example\.com|bob@example\.com|4111|sk-abcdefghijklmnopqrstu/);
    expect(stored).toContain("[card hidden]");
    expect(stored).toContain("[email hidden]");
  });
});

describe("tools never run", () => {
  it("makes no outgoing request at all, even for tool steps that carry web links", async () => {
    const team = await makeTeam("no-network");
    const original = await makeStory(team);
    // Any real call out of this server would go through fetch (the AI client uses it too, but the demo model does not).
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("A real network call was made during a fork!");
    });
    const res = await fork(team.token, original._id, { fromStepIndex: 0, edits: { 2: { output: "pretend result" } } });
    expect(res.status).toBe(201);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("only ever asks the AI model about AI steps: tools are never passed to anything that could run them", async () => {
    const team = await makeTeam("only-ai");
    const original = await makeStory(team);
    const asked: Array<{ model: string; system?: string; messages: Array<{ role: string; content: string }> }> = [];
    // A stand-in for the AI model that records every question. There is no stand-in for tools: the fork code has none to call.
    const ask = jest.fn(async (request: (typeof asked)[number]) => {
      asked.push(request);
      return { text: "scripted", model: request.model, inputTokens: 2, outputTokens: 1 };
    });
    const created = await forkRun(new Types.ObjectId(team.workspaceId), String(original._id), { fromStepIndex: 0, edits: {} }, ask);
    expect(ask).toHaveBeenCalledTimes(1); // the story has exactly one AI step
    expect(asked[0]).toMatchObject({ model: "gpt-4o-mini", system: "You are a polite support agent.", messages: [{ role: "user", content: WRONG_PROMPT }] });
    const steps = await stepsOf(created._id);
    expect(steps.filter((step) => step.type !== "llm").every((step) => step.origin === "simulated")).toBe(true);
  });
});

describe("what a fork refuses", () => {
  let team: Team;
  let original: Awaited<ReturnType<typeof makeStory>>;
  beforeAll(async () => {
    team = await makeTeam("validation");
    original = await makeStory(team);
  });
  const countForks = () => Run.countDocuments({ parentRunId: original._id });

  it.each([
    ["no step", {}],
    ["a negative step", { fromStepIndex: -1 }],
    ["a fractional step", { fromStepIndex: 1.5 }],
    ["a step number past the limit", { fromStepIndex: 1000 }],
    ["a step that does not exist", { fromStepIndex: 9 }],
    ["an edit to a step before the fork point", { fromStepIndex: 2, edits: { 1: { prompt: "x" } } }],
    ["an edit to a step that does not exist", { fromStepIndex: 1, edits: { 9: { output: "x" } } }],
    ["a prompt for a tool step", { fromStepIndex: 1, edits: { 2: { prompt: "x" } } }],
    ["a model for a tool step", { fromStepIndex: 1, edits: { 2: { model: "m" } } }],
    ["a typed result for an AI step", { fromStepIndex: 1, edits: { 1: { output: "x" } } }],
    ["a step number that is not a number", { fromStepIndex: 1, edits: { first: { prompt: "x" } } }],
    ["an empty model name", { fromStepIndex: 1, edits: { 1: { model: "  " } } }],
  ])("refuses %s with a friendly 400 and saves nothing", async (_label, body) => {
    const before = await countForks();
    const res = await fork(team.token, original._id, body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(await countForks()).toBe(before);
  });

  it("refuses more than 50 changed steps", async () => {
    const edits = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [String(index), { output: "x" }]));
    expect((await fork(team.token, original._id, { fromStepIndex: 0, edits })).status).toBe(400);
  });

  it("refuses a fork that would ask the AI too many times, and says why", async () => {
    const big = await Run.create({ workspaceId: team.workspaceId, appId: team.appId, name: "Many AI steps", stepCount: MAX_LLM_STEPS_PER_FORK + 1 });
    await Step.insertMany(Array.from({ length: MAX_LLM_STEPS_PER_FORK + 1 }, (_, index) => ({ runId: big._id, index, type: "llm", name: `ask ${index}`, input: "hi", output: "hello" })));
    const res = await fork(team.token, big._id, { fromStepIndex: 0, edits: {} });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/ask the AI 21 times.*limit is 20/);
    expect((await fork(team.token, big._id, { fromStepIndex: 1, edits: {} })).status).toBe(201); // 20 AI steps is allowed
  });
});

describe("when the AI cannot be reached", () => {
  it("saves nothing and counts nothing", async () => {
    const team = await makeTeam("ai-down");
    const original = await makeStory(team);
    const today = dayKey(new Date());
    const counters = async () => (await StorageUsage.find({ workspaceId: team.workspaceId }).sort({ day: 1 }).lean()).map((item) => [item.day, item.bytes]);
    const before = { runs: await Run.countDocuments({ appId: team.appId }), steps: await Step.countDocuments(), counters: await counters() };
    expect(before.counters).toEqual([[today, expect.any(Number)], ["total", expect.any(Number)]]); // the story's own recording

    jest.spyOn(llmClient, "completeChat").mockRejectedValueOnce(new ServiceUnavailableError("Could not reach the AI service. Check the AI settings and try again."));
    const res = await fork(team.token, original._id, fix);
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/Could not reach the AI service/);
    expect({ runs: await Run.countDocuments({ appId: team.appId }), steps: await Step.countDocuments(), counters: await counters() }).toEqual(before);
  });
});

describe("storage", () => {
  it("counts everything a fork stores against the workspace limit", async () => {
    const team = await makeTeam("storage-count");
    const original = await makeStory(team);
    const today = dayKey(new Date());
    const before = (await StorageUsage.findOne({ workspaceId: team.workspaceId, day: today }).lean())!.bytes;
    const res = await fork(team.token, original._id, fix);
    const stored = await stepsOf(res.body.data.run.id);
    const bytes = stored.reduce((total, step) => total + Buffer.byteLength(step.name) + Buffer.byteLength(step.input) + Buffer.byteLength(step.output) + Buffer.byteLength(step.error), 0);
    expect((await StorageUsage.findOne({ workspaceId: team.workspaceId, day: today }).lean())!.bytes).toBe(before + bytes + RUN_STORAGE_BYTES); // the fork run itself counts 1 KB
  });

  it("refuses with a friendly 429 when there is no room, and saves nothing", async () => {
    const team = await makeTeam("storage-full");
    const original = await makeStory(team);
    const today = dayKey(new Date());
    await StorageUsage.updateOne({ workspaceId: team.workspaceId, day: today }, { $set: { bytes: MAX_BYTES_PER_WORKSPACE_PER_DAY - 10 } });
    const res = await fork(team.token, original._id, fix);
    expect(res.status).toBe(429);
    expect(res.body.message).toBe("This workspace has reached its storage limit for today.");
    expect(await Run.countDocuments({ parentRunId: original._id })).toBe(0);
    expect((await StorageUsage.findOne({ workspaceId: team.workspaceId, day: today }).lean())!.bytes).toBe(MAX_BYTES_PER_WORKSPACE_PER_DAY - 10);
  });
});

describe("Fork compare", () => {
  it("lines the original and the fork up step by step and marks only what really changed", async () => {
    const team = await makeTeam("compare");
    const original = await makeStory(team);
    const made = await fork(team.token, original._id, fix);
    const res = await compare(team.token, made.body.data.run.id);
    expect(res.status).toBe(200);
    expect(res.body.data.original).toMatchObject({ id: String(original._id), name: "Refund chat" });
    expect(res.body.data.fork).toMatchObject({ id: made.body.data.run.id, parentRunId: String(original._id), parentRunName: "Refund chat" });
    expect(res.body.data.forkedFromIndex).toBe(1);
    expect(res.body.data.rows.map((row: { index: number; origin: string; changed: boolean }) => [row.index, row.origin, row.changed])).toEqual([
      [0, "copied", false],
      [1, "rerun", true],
      [2, "simulated", false],
      [3, "simulated", false],
    ]);
    expect(res.body.data.rows[1].original).toMatchObject({ name: "draft_answer", tokens: 180 });
    expect(res.body.data.rows[1].fork).toMatchObject({ name: "draft_answer", origin: "rerun" });
    expect(JSON.stringify(res.body)).not.toMatch(/Your refund for order 10/); // step text is fetched one step at a time
  });

  it("does not call a step changed when asking the AI again gave the very same answer", async () => {
    const team = await makeTeam("same-answer");
    const original = await makeStory(team);
    const made = await fork(team.token, original._id, { fromStepIndex: 1, edits: {} });
    const res = await compare(team.token, made.body.data.run.id);
    expect(res.body.data.rows.some((row: { changed: boolean }) => row.changed)).toBe(false);
  });

  it("marks a hand-typed tool result as changed", async () => {
    const team = await makeTeam("edited-row");
    const original = await makeStory(team);
    const made = await fork(team.token, original._id, { fromStepIndex: 2, edits: { 2: { output: "pretend" } } });
    const rows = (await compare(team.token, made.body.data.run.id)).body.data.rows;
    expect(rows[2]).toMatchObject({ origin: "edited", changed: true });
  });

  it("lets viewers look at a comparison", async () => {
    const team = await makeTeam("compare-viewer");
    const original = await makeStory(team);
    const made = await fork(team.token, original._id, fix);
    const viewer = await loginAs(team, "viewer@compare.test.example", "viewer");
    expect((await compare(viewer, made.body.data.run.id)).status).toBe(200);
  });

  it("needs a sign-in, refuses another team, and says so for runs that are not forks", async () => {
    const [a, b] = await Promise.all([makeTeam("cmp-a"), makeTeam("cmp-b")]);
    const original = await makeStory(a);
    const made = await fork(a.token, original._id, fix);
    expect((await request(app).get(`/api/runs/${made.body.data.run.id}/compare`)).status).toBe(401);
    expect((await compare(b.token, made.body.data.run.id)).status).toBe(404);
    const notAFork = await compare(a.token, original._id);
    expect(notAFork.status).toBe(400);
    expect(notAFork.body.message).toMatch(/not a fork/);
    expect((await compare(a.token, "not-an-id")).status).toBe(404);
  });

  it("says so when the original run is gone", async () => {
    const team = await makeTeam("orphan");
    const original = await makeStory(team);
    const made = await fork(team.token, original._id, fix);
    await Run.deleteOne({ _id: original._id });
    const res = await compare(team.token, made.body.data.run.id);
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/no longer available/);
  });

  it("never reaches out to anything while comparing", async () => {
    const team = await makeTeam("compare-offline");
    const original = await makeStory(team);
    const made = await fork(team.token, original._id, fix);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("A real network call was made while comparing!");
    });
    expect((await compare(team.token, made.body.data.run.id)).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Undo the original actions", () => {
  async function runWithLinks(team: Team) {
    const run = await Run.create({ workspaceId: team.workspaceId, appId: team.appId, name: "Linked run", stepCount: 6 });
    const step = (index: number, name: string, externalRef?: { system: string; id: string; url: string }) => ({ runId: run._id, index, type: "tool", name, input: "in", output: "out", ...(externalRef ? { externalRef } : {}) });
    await Step.insertMany([
      step(0, "refund", { system: "agentguard", id: "act_1", url: "https://agentguard.example.com/activity/act_1" }),
      step(1, "charge_card", { system: "stripe", id: "pi_1", url: "https://dashboard.stripe.com/payments/pi_1" }),
      step(2, "email", { system: "agentguard", id: "act_2", url: "http://localhost:5173/activity/act_2" }),
      step(3, "no link"),
      // Saved before the link rules existed (or put there by hand): must never become a button.
      step(4, "bad script", { system: "agentguard", id: "act_3", url: "javascript:alert(1)" }),
      step(5, "bad http", { system: "agentguard", id: "act_4", url: "http://evil.example.com/activity/act_4" }),
    ]);
    return run;
  }

  it("lists only AgentGuard links that are safe to open", async () => {
    const team = await makeTeam("undo-list");
    const original = await runWithLinks(team);
    const made = await fork(team.token, original._id, { fromStepIndex: 3, edits: {} });
    const res = await compare(team.token, made.body.data.run.id);
    expect(res.body.data.undoLinks).toEqual([
      { index: 0, name: "refund", id: "act_1", url: "https://agentguard.example.com/activity/act_1" },
      { index: 2, name: "email", id: "act_2", url: "http://localhost:5173/activity/act_2" },
    ]);
  });

  it("lists nothing when the original has no AgentGuard links", async () => {
    const team = await makeTeam("undo-none");
    const run = await Run.create({ workspaceId: team.workspaceId, appId: team.appId, name: "Plain", stepCount: 1 });
    await Step.create({ runId: run._id, index: 0, type: "tool", name: "stripe only", externalRef: { system: "stripe", id: "pi_9", url: "https://dashboard.stripe.com/payments/pi_9" } });
    const made = await fork(team.token, run._id, { fromStepIndex: 0, edits: {} });
    expect((await compare(team.token, made.body.data.run.id)).body.data.undoLinks).toEqual([]);
  });

  it("does not list the links of the fork's own simulated steps", async () => {
    const team = await makeTeam("undo-fork-own");
    const original = await makeStory(team);
    const made = await fork(team.token, original._id, { fromStepIndex: 0, edits: {} });
    // The original's issue_refund step carries the AgentGuard link; the fork's simulated copy of it does not.
    const res = await compare(team.token, made.body.data.run.id);
    expect(res.body.data.undoLinks).toEqual([{ index: 2, name: "issue_refund", id: "act_1", url: "https://agentguard.example.com/activity/act_1" }]);
  });
});
