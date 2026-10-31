import request from "supertest";
import { Types } from "mongoose";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import {
  MAX_BYTES_PER_WORKSPACE_PER_DAY,
  MAX_FORKS_PER_DAY_DEMO_PROVIDER,
  MAX_FORKS_PER_DAY_REAL_PROVIDER,
} from "../src/constants";
import { ServiceUnavailableError } from "../src/helpers/errors";
import { ForkUsage } from "../src/models/forkUsage.model";
import { Run } from "../src/models/run.model";
import { Step } from "../src/models/step.model";
import { StorageUsage } from "../src/models/storageUsage.model";
import { User } from "../src/models/user.model";
import { hashPassword } from "../src/services/auth/auth.service";
import { forkRun } from "../src/services/forks/fork.service";
import { dayKey } from "../src/services/ingest/storageQuota.service";
import * as llmClient from "../src/services/llm/llmClient";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// Cost limits on forks, through the real HTTP API with a real (in-memory) MongoDB. A fork asks an AI model, and with a
// paid provider that costs the owner money, while anyone (including demo visitors) can start forks.

const app = createApp();
const PASSWORD = "a-good-password";
const TODAY = dayKey(new Date());
const originalEnv = { ...env };

interface Team {
  token: string;
  workspaceId: string;
  appId: string;
  apiKey: string;
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });
const OPENAI_REPLY = { model: "gpt-4.1-mini-2025-04-14", usage: { prompt_tokens: 20, completion_tokens: 10 }, choices: [{ message: { content: "An answer from a paid model." } }] };
const DEMO_FIXED = "Your refund for order 1042 is ₹2,400.";

async function teamFrom(token: string, workspaceId: string): Promise<Team> {
  const created = await request(app).post("/api/apps").set(authed(token)).send({ name: `Support bot ${Math.random()}` });
  return { token, workspaceId, appId: created.body.data.id, apiKey: created.body.data.apiKey };
}

async function makeTeam(label: string): Promise<Team> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ name: "Test Person", workspaceName: `Team ${label}`, email: `${label}@forkcosts.test.example`, password: PASSWORD });
  return teamFrom(signup.body.data.token, signup.body.data.user.workspaceId);
}

// Anyone can press "Try the demo": the shared demo workspace.
async function makeDemoTeam(): Promise<Team> {
  const demo = await request(app).post("/api/auth/demo");
  return teamFrom(demo.body.data.token, demo.body.data.user.workspaceId);
}

const ingest = (team: Team, body: unknown) => request(app).post("/api/ingest").set("x-api-key", team.apiKey).send(body as object);
const fork = (team: Team, runId: Types.ObjectId | string, body: unknown) => request(app).post(`/api/runs/${runId}/fork`).set(authed(team.token)).send(body as object);

let counter = 0;
async function makeStory(team: Team) {
  counter += 1;
  const id = `cost-story-${counter}`;
  await ingest(team, {
    runs: [{ id, name: "Refund chat", status: "ok", durationMs: 1000 }],
    steps: [
      { runId: id, index: 0, type: "retrieval", name: "find_order", input: "in", output: "out", durationMs: 40 },
      {
        runId: id,
        index: 1,
        type: "llm",
        name: "draft_answer",
        model: "gpt-4o-mini",
        input: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Refund for order 1042. Order data: order 1041, total ₹1800." }] }),
        output: "Your refund for order 1041 is ₹1,800.",
        tokens: 100,
        durationMs: 600,
      },
      { runId: id, index: 2, type: "tool", name: "issue_refund", input: "in", output: "refunded", durationMs: 60 },
    ],
  });
  return (await Run.findOne({ appId: team.appId, externalId: id }).lean())!;
}

const fixPrompt = (index = 1) => ({ fromStepIndex: index, edits: { 1: { prompt: "Refund for order 1042. Order data: order 1042, total ₹2,400." } } });
const forkCount = async (team: Team, day = TODAY) => (await ForkUsage.findOne({ workspaceId: team.workspaceId, day }).lean())?.count ?? 0;
const setForkCount = (team: Team, count: number, day = TODAY) => ForkUsage.updateOne({ workspaceId: team.workspaceId, day }, { $set: { count } }, { upsert: true });
const stepsOf = (runId: string) => Step.find({ runId }).sort({ index: 1 }).lean();
const everythingSaved = async (team: Team) => ({
  runs: await Run.countDocuments({ workspaceId: team.workspaceId }),
  steps: await Step.countDocuments(),
  storage: (await StorageUsage.find({ workspaceId: team.workspaceId }).sort({ day: 1 }).lean()).map((item) => [item.day, item.bytes]),
});

function usePaidOpenAi(extra: Partial<typeof env> = {}) {
  Object.assign(env, { LLM_PROVIDER: "openai", LLM_API_KEY: "sk-test-not-a-real-key-1234567890", LLM_MODEL: "gpt-4.1-mini", LLM_ALLOWED_MODELS: ["gpt-4o-mini"], LLM_BASE_URL: "", ...extra });
  const calls: Array<{ body: Record<string, any> }> = [];
  const spy = jest.spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => OPENAI_REPLY };
  }) as never);
  return { calls, spy };
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

describe("the demo workspace", () => {
  it("never reaches a paid provider, even when one is set up", async () => {
    const demo = await makeDemoTeam();
    const run = await makeStory(demo);
    const { spy, calls } = usePaidOpenAi();
    const res = await fork(demo, run._id, fixPrompt());
    expect(res.status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    const [, asked] = await stepsOf(res.body.data.run.id);
    expect(asked).toMatchObject({ origin: "rerun", note: "" });
    expect(asked.output).toContain(DEMO_FIXED); // the free scripted model answered
  });

  it("uses the paid provider for an ordinary workspace under the very same settings", async () => {
    const team = await makeTeam("paid-for-real");
    const run = await makeStory(team);
    const { calls } = usePaidOpenAi();
    const res = await fork(team, run._id, fixPrompt());
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    const [, asked] = await stepsOf(res.body.data.run.id);
    expect(asked).toMatchObject({ output: "An answer from a paid model.", tokens: 30, model: "gpt-4.1-mini-2025-04-14" });
    expect(calls[0].body.max_completion_tokens).toBe(1500);
  });

  it("works for the demo even when the paid provider has no key", async () => {
    const demo = await makeDemoTeam();
    const run = await makeStory(demo);
    Object.assign(env, { LLM_PROVIDER: "anthropic", LLM_API_KEY: "" });
    expect((await fork(demo, run._id, fixPrompt())).status).toBe(201);
  });
});

describe("the model allow-list", () => {
  it("replaces a model that is not allowed, and the step says so", async () => {
    const team = await makeTeam("not-allowed");
    const run = await makeStory(team);
    const { calls } = usePaidOpenAi();
    const res = await fork(team, run._id, { fromStepIndex: 1, edits: { 1: { model: "gpt-4o" } } });
    expect(res.status).toBe(201);
    expect(calls[0].body.model).toBe("gpt-4.1-mini"); // gpt-4o was never asked for
    const [, asked] = await stepsOf(res.body.data.run.id);
    expect(asked.note).toBe("Used gpt-4.1-mini instead of gpt-4o, which is not allowed here.");

    const detail = await request(app).get(`/api/runs/${res.body.data.run.id}/steps/1`).set(authed(team.token));
    expect(detail.body.data.note).toBe("Used gpt-4.1-mini instead of gpt-4o, which is not allowed here.");
    const comparison = await request(app).get(`/api/runs/${res.body.data.run.id}/compare`).set(authed(team.token));
    expect(comparison.body.data.rows[1].fork.note).toBe("Used gpt-4.1-mini instead of gpt-4o, which is not allowed here.");
    expect(comparison.body.data.rows[0].fork.note).toBe("");
  });

  it("uses a model that is on the list, without a note", async () => {
    const team = await makeTeam("allowed");
    const run = await makeStory(team);
    const { calls } = usePaidOpenAi();
    const res = await fork(team, run._id, { fromStepIndex: 1, edits: { 1: { model: "gpt-4o-mini" } } });
    expect(calls[0].body.model).toBe("gpt-4o-mini");
    expect((await stepsOf(res.body.data.run.id))[1].note).toBe("");
  });

  it("allows only LLM_MODEL when the list is empty, even for the model the step was recorded with", async () => {
    const team = await makeTeam("empty-list");
    const run = await makeStory(team);
    const { calls } = usePaidOpenAi({ LLM_ALLOWED_MODELS: [] });
    const res = await fork(team, run._id, { fromStepIndex: 1, edits: {} }); // the step was recorded with gpt-4o-mini
    expect(calls[0].body.model).toBe("gpt-4.1-mini");
    expect((await stepsOf(res.body.data.run.id))[1].note).toBe("Used gpt-4.1-mini instead of gpt-4o-mini, which is not allowed here.");
  });

  it("keeps recorded steps free of notes", async () => {
    const team = await makeTeam("no-notes");
    const run = await makeStory(team);
    const detail = await request(app).get(`/api/runs/${run._id}/steps/1`).set(authed(team.token));
    expect(detail.body.data.note).toBe("");
  });
});

describe("the daily limit on forks", () => {
  it("allows as many forks as the demo model's limit and then refuses, saving nothing", async () => {
    const team = await makeTeam("limit-demo-model");
    const run = await makeStory(team);
    await setForkCount(team, MAX_FORKS_PER_DAY_DEMO_PROVIDER - 1);
    expect((await fork(team, run._id, fixPrompt())).status).toBe(201);
    expect(await forkCount(team)).toBe(MAX_FORKS_PER_DAY_DEMO_PROVIDER);

    const before = await everythingSaved(team);
    const refused = await fork(team, run._id, fixPrompt());
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ success: false, message: "This workspace has used today's forks. Try again tomorrow." });
    expect(await everythingSaved(team)).toEqual(before);
    expect(await forkCount(team)).toBe(MAX_FORKS_PER_DAY_DEMO_PROVIDER);
  });

  it("is lower with a paid provider", async () => {
    const team = await makeTeam("limit-paid");
    const run = await makeStory(team);
    const { calls } = usePaidOpenAi();
    expect(MAX_FORKS_PER_DAY_REAL_PROVIDER).toBe(30);
    expect(MAX_FORKS_PER_DAY_DEMO_PROVIDER).toBe(100);
    await setForkCount(team, MAX_FORKS_PER_DAY_REAL_PROVIDER - 1);
    expect((await fork(team, run._id, fixPrompt())).status).toBe(201);
    const refused = await fork(team, run._id, fixPrompt());
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe("This workspace has used today's forks. Try again tomorrow.");
    expect(calls).toHaveLength(1); // the refused fork never asked the AI
  });

  it("gives the demo workspace the higher limit, because it only ever uses the free model", async () => {
    const demo = await makeDemoTeam();
    const run = await makeStory(demo);
    const { spy } = usePaidOpenAi();
    await setForkCount(demo, MAX_FORKS_PER_DAY_REAL_PROVIDER); // already past the paid limit
    expect((await fork(demo, run._id, fixPrompt())).status).toBe(201);
    await setForkCount(demo, MAX_FORKS_PER_DAY_DEMO_PROVIDER);
    expect((await fork(demo, run._id, fixPrompt())).status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it("counts each workspace on its own", async () => {
    const full = await makeTeam("limit-full");
    const free = await makeTeam("limit-free");
    const fullRun = await makeStory(full);
    const freeRun = await makeStory(free);
    await setForkCount(full, MAX_FORKS_PER_DAY_DEMO_PROVIDER);
    expect((await fork(full, fullRun._id, fixPrompt())).status).toBe(429);
    expect((await fork(free, freeRun._id, fixPrompt())).status).toBe(201);
    expect(await forkCount(free)).toBe(1);
    expect(await forkCount(full)).toBe(MAX_FORKS_PER_DAY_DEMO_PROVIDER);
  });

  it("starts a fresh count every day, and keeps each day's counter for a while only", async () => {
    const team = await makeTeam("limit-new-day");
    const run = await makeStory(team);
    const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await setForkCount(team, MAX_FORKS_PER_DAY_DEMO_PROVIDER, yesterday);
    expect((await fork(team, run._id, fixPrompt())).status).toBe(201);
    expect(await forkCount(team)).toBe(1);
    expect((await ForkUsage.findOne({ workspaceId: team.workspaceId, day: TODAY }).lean())!.expiresAt).toBeInstanceOf(Date);
  });

  it("does not use up a fork when the request is turned away before anything is asked", async () => {
    const team = await makeTeam("limit-not-used");
    const run = await makeStory(team);
    expect((await fork(team, run._id, { fromStepIndex: 9, edits: {} })).status).toBe(400); // a step that does not exist
    expect((await fork(team, run._id, { fromStepIndex: 1, edits: { 2: { prompt: "x" } } })).status).toBe(400);
    expect((await fork(team, new Types.ObjectId(), fixPrompt())).status).toBe(404);
    const other = await makeTeam("limit-not-used-other");
    expect((await fork(other, run._id, fixPrompt())).status).toBe(404);
    await User.create({ workspaceId: team.workspaceId, name: "Viewer", email: "look@forkcosts.test.example", role: "viewer", passwordHash: await hashPassword(PASSWORD) });
    const login = await request(app).post("/api/auth/login").send({ email: "look@forkcosts.test.example", password: PASSWORD });
    expect((await fork({ ...team, token: login.body.data.token }, run._id, fixPrompt())).status).toBe(403);
    expect(await forkCount(team)).toBe(0);
  });

  it("gives the fork back when the AI cannot be reached, or when there is no storage room", async () => {
    const team = await makeTeam("limit-given-back");
    const run = await makeStory(team);
    jest.spyOn(llmClient, "completeChat").mockRejectedValueOnce(new ServiceUnavailableError("Could not reach the AI service. Check the AI settings and try again."));
    expect((await fork(team, run._id, fixPrompt())).status).toBe(503);
    expect(await forkCount(team)).toBe(0);

    await StorageUsage.updateOne({ workspaceId: team.workspaceId, day: TODAY }, { $set: { bytes: MAX_BYTES_PER_WORKSPACE_PER_DAY - 5 } });
    const full = await fork(team, run._id, fixPrompt());
    expect(full.status).toBe(429);
    expect(full.body.message).toBe("This workspace has reached its storage limit for today.");
    expect(await forkCount(team)).toBe(0);
  });

  it("holds the limit when many forks are started at the same moment", async () => {
    const team = await makeTeam("limit-race");
    const run = await makeStory(team);
    await setForkCount(team, MAX_FORKS_PER_DAY_DEMO_PROVIDER - 3);
    const results = await Promise.all(Array.from({ length: 8 }, () => fork(team, run._id, fixPrompt())));
    expect(results.filter((res) => res.status === 201)).toHaveLength(3);
    const refused = results.filter((res) => res.status === 429);
    expect(refused).toHaveLength(5);
    expect(refused.every((res) => res.body.message === "This workspace has used today's forks. Try again tomorrow.")).toBe(true);
    expect(await forkCount(team)).toBe(MAX_FORKS_PER_DAY_DEMO_PROVIDER);
    expect(await Run.countDocuments({ parentRunId: run._id })).toBe(3);
  });
});

describe("a fork slot is only given back when no paid call was made", () => {
  // A paid provider that accepts the request and then never answers, until the call is stopped.
  function hangingProvider(answerFirst = 0) {
    let calls = 0;
    const spy = jest.spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: { signal: AbortSignal }) => {
      calls += 1;
      if (calls <= answerFirst) return Promise.resolve({ ok: true, status: 200, json: async () => OPENAI_REPLY });
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }) as never);
    return { spy, calls: () => calls };
  }
  const paid = () => Object.assign(env, { LLM_PROVIDER: "openai", LLM_API_KEY: "sk-test-not-a-real-key-1234567890", LLM_MODEL: "gpt-4.1-mini", LLM_ALLOWED_MODELS: ["gpt-4o-mini"], LLM_BASE_URL: "" });
  const tooSlow = { callMs: 80, forkMs: 10_000 };
  const input = { fromStepIndex: 0, edits: {} };

  async function aiSteps(team: Team, count: number) {
    const run = await Run.create({ workspaceId: team.workspaceId, appId: team.appId, name: "AI steps", stepCount: count });
    await Step.insertMany(Array.from({ length: count }, (_, index) => ({ runId: run._id, index, type: "llm", name: `ask ${index}`, model: "gpt-4o-mini", input: "question", output: "answer" })));
    return run;
  }

  it("keeps the slot when one paid call was made and then the fork timed out", async () => {
    const team = await makeTeam("paid-timeout");
    const run = await aiSteps(team, 1);
    paid();
    const provider = hangingProvider();
    const before = await everythingSaved(team);
    const failure = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), input, undefined, tooSlow).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(failure.message).toMatch(/took too long to answer/);
    expect(provider.calls()).toBe(1); // the request really was sent
    expect(await forkCount(team)).toBe(1); // so the slot stays used
    expect(await everythingSaved(team)).toEqual(before); // and still nothing is saved
  });

  it("keeps the slot when a paid call worked and a later one timed out", async () => {
    const team = await makeTeam("paid-then-timeout");
    const run = await aiSteps(team, 2);
    paid();
    const provider = hangingProvider(1); // the first call is answered, the second never is
    const failure = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), input, undefined, tooSlow).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(provider.calls()).toBe(2);
    expect(await forkCount(team)).toBe(1);
  });

  it("keeps the slot when a paid call worked and the fork then failed for another reason", async () => {
    const team = await makeTeam("paid-then-storage");
    const run = await aiSteps(team, 1);
    paid();
    hangingProvider(1);
    await StorageUsage.updateOne({ workspaceId: team.workspaceId, day: TODAY }, { $set: { bytes: MAX_BYTES_PER_WORKSPACE_PER_DAY - 5 } }, { upsert: true });
    const failure = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), input).catch((error) => error);
    expect(failure.statusCode).toBe(429); // no storage room, after the paid call was already made
    expect(await forkCount(team)).toBe(1);
  });

  it("means repeated timeouts cannot get around the daily limit", async () => {
    const team = await makeTeam("paid-repeat");
    const run = await aiSteps(team, 1);
    paid();
    const provider = hangingProvider();
    await setForkCount(team, MAX_FORKS_PER_DAY_REAL_PROVIDER - 2);
    for (let attempt = 0; attempt < 2; attempt++) {
      await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), input, undefined, tooSlow).catch(() => undefined);
    }
    expect(provider.calls()).toBe(2); // two paid calls were made...
    expect(await forkCount(team)).toBe(MAX_FORKS_PER_DAY_REAL_PROVIDER); // ...and both used up a slot
    const refused = await fork(team, run._id, input);
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe("This workspace has used today's forks. Try again tomorrow.");
    expect(provider.calls()).toBe(2); // the refused fork made no call
  });

  it("gives the slot back when the failure happened before anything reached the provider", async () => {
    const team = await makeTeam("paid-not-sent");
    const run = await aiSteps(team, 1);
    Object.assign(env, { LLM_PROVIDER: "openai", LLM_API_KEY: "" }); // not set up properly, so nothing can be sent
    const { spy } = hangingProvider();
    const failure = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), input).catch((error) => error);
    expect(failure.message).toMatch(/AI is not set up/);
    expect(spy).not.toHaveBeenCalled();
    expect(await forkCount(team)).toBe(0);
  });

  it("gives the slot back when the free demo model is the one that failed, because it cost nothing", async () => {
    const team = await makeTeam("demo-model-timeout");
    const run = await aiSteps(team, 1);
    const never = () => new Promise<never>(() => undefined);
    const failure = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), input, never, tooSlow).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(await forkCount(team)).toBe(0);
  });

  it("gives the slot back for the demo workspace even when a paid provider is set up, because it never reaches it", async () => {
    const demo = await makeDemoTeam();
    const run = await aiSteps(demo, 1);
    paid();
    const { spy } = hangingProvider();
    await setForkCount(demo, 0); // earlier tests may have used the demo workspace's slots; start clean so the fork is really tried
    const before = await forkCount(demo);
    // Something goes wrong after the slot is taken (the AI stand-in never answers).
    const never = () => new Promise<never>(() => undefined);
    await forkRun(new Types.ObjectId(demo.workspaceId), String(run._id), input, never, tooSlow).catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
    expect(await forkCount(demo)).toBe(before);
  });

  it("is also true for a fork that fails because the paid provider refuses the request", async () => {
    const team = await makeTeam("paid-refused");
    const run = await aiSteps(team, 1);
    paid();
    jest.spyOn(globalThis, "fetch").mockImplementation((async () => ({ ok: false, status: 401, json: async () => ({}) })) as never);
    const failure = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), input).catch((error) => error);
    expect(failure.message).toMatch(/answered with status 401/);
    expect(await forkCount(team)).toBe(1); // the request reached the provider
  });
});

describe("the time limits", () => {
  const input = fixPrompt();
  const slow = (ms: number) => async (request: llmClient.ChatRequest) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { text: "late answer", model: request.model, inputTokens: 1, outputTokens: 1 };
  };

  async function manyAiSteps(team: Team, count: number) {
    const run = await Run.create({ workspaceId: team.workspaceId, appId: team.appId, name: "Many AI steps", stepCount: count });
    await Step.insertMany(Array.from({ length: count }, (_, index) => ({ runId: run._id, index, type: "llm", name: `ask ${index}`, model: "gpt-4o-mini", input: "question", output: "answer" })));
    return run;
  }

  it("stops one AI call that takes too long, saves nothing and counts nothing", async () => {
    const team = await makeTeam("time-call");
    const run = await makeStory(team);
    const before = await everythingSaved(team);
    const never = () => new Promise<never>(() => undefined);
    const failure = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), input, never, { callMs: 80, forkMs: 10_000 }).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(failure.statusCode).toBe(503);
    expect(failure.message).toMatch(/The AI took too long to answer \(over 30 seconds\).*Nothing was saved/);
    expect(await everythingSaved(team)).toEqual(before);
    expect(await forkCount(team)).toBe(0);
  });

  it("stops a whole fork that takes too long, saves nothing and counts nothing", async () => {
    const team = await makeTeam("time-fork");
    const run = await manyAiSteps(team, 4);
    const before = await everythingSaved(team);
    const started = Date.now();
    const failure = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), { fromStepIndex: 0, edits: {} }, slow(120), { callMs: 1000, forkMs: 250 }).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(failure.message).toMatch(/This fork took too long \(over 90 seconds\).*Nothing was saved/);
    expect(Date.now() - started).toBeLessThan(1500); // it stopped; it did not wait for all four calls
    expect(await everythingSaved(team)).toEqual(before);
    expect(await forkCount(team)).toBe(0);
    expect(await Run.countDocuments({ parentRunId: run._id })).toBe(0);
  });

  it("gives each AI call only the time that is left of the whole fork", async () => {
    const team = await makeTeam("time-left");
    const run = await manyAiSteps(team, 3);
    const options: Array<number | undefined> = [];
    const quick = async (request: llmClient.ChatRequest, callOptions?: llmClient.ChatOptions) => {
      options.push(callOptions?.timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { text: "answer", model: request.model, inputTokens: 1, outputTokens: 1 };
    };
    const made = await forkRun(new Types.ObjectId(team.workspaceId), String(run._id), { fromStepIndex: 0, edits: {} }, quick, { callMs: 5000, forkMs: 1000 });
    expect(made.stepCount).toBe(3);
    expect(options).toHaveLength(3);
    expect(options[0]).toBeLessThanOrEqual(1000);
    expect(options[1]! < options[0]!).toBe(true); // time is running down
    expect(options[2]! < options[1]!).toBe(true);
    expect(await forkCount(team)).toBe(1); // a fork that finished in time is counted
  });

  it("answers a friendly 503 over HTTP, with nothing saved or counted", async () => {
    const team = await makeTeam("time-http");
    const run = await makeStory(team);
    const before = await everythingSaved(team);
    jest.spyOn(llmClient, "completeChat").mockRejectedValueOnce(new ServiceUnavailableError("The AI took too long to answer (over 30 seconds), so it was stopped. Nothing was saved. Please try again."));
    const res = await fork(team, run._id, input);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, message: expect.stringMatching(/took too long to answer/) });
    expect(await everythingSaved(team)).toEqual(before);
    expect(await forkCount(team)).toBe(0);
  });
});
