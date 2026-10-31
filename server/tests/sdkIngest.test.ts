import request from "supertest";
import { createApp } from "../src/app";
import { Run } from "../src/models/run.model";
import { Step } from "../src/models/step.model";
import { AgentReplay, wrapOpenAI } from "../../sdk/src";
import { FetchLike } from "../../sdk/src/types";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The real SDK talking to the real API: proves what the SDK sends is exactly what the server accepts,
// and that a recorded run comes out the other side as a run with ordered, masked steps.

const app = createApp();
let apiKey = "";
let appId = "";

// Replaces the network: the SDK's request goes straight into the Express app, and the answers are recorded.
const statuses: number[] = [];
const viaApp: FetchLike = async (url, init) => {
  const res = await request(app).post(new URL(url).pathname).set(init.headers).send(init.body);
  statuses.push(res.status);
  return { status: res.status, headers: { get: (name) => (res.headers[name.toLowerCase()] as string | undefined) ?? null } };
};

const makeClient = () => new AgentReplay({ apiKey, baseUrl: "http://agentreplay.test", fetch: viaApp, flushIntervalMs: 60_000 });

beforeAll(async () => {
  await startTestDb();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ name: "SDK Person", workspaceName: "SDK Team", email: "sdk@ingest.test.example", password: "a-good-password" });
  const created = await request(app).post("/api/apps").set({ authorization: `Bearer ${signup.body.data.token}` }).send({ name: "Support bot" });
  apiKey = created.body.data.apiKey;
  appId = created.body.data.id;
});

afterAll(async () => {
  await stopTestDb();
});

describe("a run recorded with the SDK", () => {
  it("arrives as one ordered, masked, finished run", async () => {
    const client = makeClient();
    const run = client.startRun({ name: "Support chat", userRef: "ann@example.com", tags: ["refund"] });

    await run.trace("retrieval", "find_order", async () => ({ orderId: 1042, total: 2400 }), { input: { customer: "ann@example.com" } });
    run.step({ type: "llm", name: "answer", input: "Refund for order 1042?", output: "Your refund is ₹2,400.", model: "gpt-4o-mini", tokens: 120, costUsd: 0.0004, durationMs: 300 });
    await run.trace("tool", "issue_refund", async () => "ok", { input: { card: "4111 1111 1111 1111" } });
    run.step({ type: "custom", name: "note", output: "sent with key sk-abcdefghijklmnopqrstu" });
    await run.trace("tool", "send_email", async () => Promise.reject(new Error("mail server down"))).catch(() => undefined);
    run.end();
    await client.flush();

    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((status) => status === 200)).toBe(true);

    const saved = await Run.findOne({ appId, externalId: run.id }).lean();
    expect(saved).toMatchObject({ name: "Support chat", status: "failed", model: "gpt-4o-mini", totalTokens: 120, stepCount: 5, tags: ["refund"] });
    expect(saved!.durationMs).toBeGreaterThanOrEqual(0);
    const steps = await Step.find({ runId: saved!._id }).sort({ index: 1 }).lean();
    expect(steps.map((item) => [item.index, item.type, item.name])).toEqual([
      [0, "retrieval", "find_order"],
      [1, "llm", "answer"],
      [2, "tool", "issue_refund"],
      [3, "custom", "note"],
      [4, "tool", "send_email"],
    ]);
    expect(steps[4].error).toBe("Error: mail server down");
    expect(steps[1]).toMatchObject({ model: "gpt-4o-mini", tokens: 120, durationMs: 300, output: "Your refund is ₹2,400." });

    const stored = JSON.stringify([saved, steps]);
    expect(stored).not.toMatch(/ann@example\.com|4111|sk-abcdefghijklmnopqrstu/);
  });

  it("records a wrapped OpenAI call as an AI step", async () => {
    const client = makeClient();
    const run = client.startRun({ name: "Wrapped call" });
    const fakeOpenAI = {
      chat: {
        completions: {
          create: async (_body?: unknown) => ({ model: "gpt-4o-mini", usage: { prompt_tokens: 40, completion_tokens: 10 }, choices: [{ message: { content: "Hello!" } }] }),
        },
      },
    };
    const ai = wrapOpenAI(fakeOpenAI, run, { price: { inputPerMillion: 150_000, outputPerMillion: 600_000 } });
    const response = await ai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Say hi" }] });
    expect(response.choices[0].message.content).toBe("Hello!");
    run.end();
    await client.flush();

    const saved = await Run.findOne({ appId, externalId: run.id }).lean();
    expect(saved).toMatchObject({ status: "ok", model: "gpt-4o-mini", totalTokens: 50, stepCount: 1 });
    expect(saved!.costUsd).toBeCloseTo(0.012, 6);
    const [step] = await Step.find({ runId: saved!._id }).lean();
    expect(step).toMatchObject({ type: "llm", output: "Hello!" });
    expect(step.input).toContain("Say hi");
  });

  it("sends a long run in several batches and every step still lands in order", async () => {
    const client = makeClient();
    const run = client.startRun({ name: "Long run" });
    for (let index = 0; index < 700; index++) run.step({ type: "tool", name: `step ${index}`, tokens: 1 });
    run.end();
    await client.flush();
    const saved = await Run.findOne({ appId, externalId: run.id }).lean();
    expect(saved).toMatchObject({ status: "ok", stepCount: 700, totalTokens: 700 });
    const steps = await Step.find({ runId: saved!._id }).sort({ index: 1 }).lean();
    expect(steps.map((item) => item.index)).toEqual(Array.from({ length: 700 }, (_, index) => index));
  });

  it("is refused politely, and the app carries on, when the key has been switched off", async () => {
    const client = new AgentReplay({ apiKey: `ar_${"0".repeat(48)}`, baseUrl: "http://agentreplay.test", fetch: viaApp });
    const run = client.startRun({ name: "No access" });
    run.step({ name: "a" });
    run.end();
    await expect(client.flush()).resolves.toBeUndefined();
    expect(statuses[statuses.length - 1]).toBe(401);
    expect(await Run.countDocuments({ name: "No access" })).toBe(0);
  });
});
