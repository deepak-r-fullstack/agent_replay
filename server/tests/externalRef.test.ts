import request from "supertest";
import { createApp } from "../src/app";
import { Run } from "../src/models/run.model";
import { Step } from "../src/models/step.model";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// A step can carry a link to a record in another system (for example the AgentGuard action it caused).
// Links are shown as buttons, so only safe ones are accepted.

const app = createApp();
const PASSWORD = "a-good-password";
const authed = (token: string) => ({ authorization: `Bearer ${token}` });

let token = "";
let appId = "";
let apiKey = "";

const send = (steps: unknown[]) => request(app).post("/api/ingest").set("x-api-key", apiKey).send({ steps });
const stepWith = (runId: string, externalRef: unknown, index = 0) => ({ runId, index, type: "tool", name: "issue_refund", input: "in", output: "out", externalRef });
const detailOf = async (runExternalId: string, index = 0) => {
  const run = await Run.findOne({ appId, externalId: runExternalId }).lean();
  return request(app).get(`/api/runs/${run!._id}/steps/${index}`).set(authed(token));
};

beforeAll(async () => {
  await startTestDb();
  const signup = await request(app).post("/api/auth/signup").send({ name: "Link Person", workspaceName: "Link Team", email: "links@ref.test.example", password: PASSWORD });
  token = signup.body.data.token;
  const created = await request(app).post("/api/apps").set(authed(token)).send({ name: "Support bot" });
  appId = created.body.data.id;
  apiKey = created.body.data.apiKey;
});

afterAll(async () => {
  await stopTestDb();
});

describe("saving a link", () => {
  it("keeps an https link, and shows it on the step", async () => {
    const ref = { system: "agentguard", id: "act_123", url: "https://agentguard.example.com/activity/act_123" };
    expect((await send([stepWith("https-ok", ref)])).status).toBe(200);
    const run = await Run.findOne({ appId, externalId: "https-ok" }).lean();
    const [saved] = await Step.find({ runId: run!._id }).lean();
    expect(saved.externalRef).toEqual(ref);
    expect((await detailOf("https-ok")).body.data.externalRef).toEqual(ref);
  });

  it("keeps an http://localhost link while not in production", async () => {
    const ref = { system: "agentguard", id: "act_9", url: "http://localhost:5173/activity/act_9" };
    expect((await send([stepWith("local-ok", ref)])).status).toBe(200);
    expect((await detailOf("local-ok")).body.data.externalRef).toEqual(ref);
  });

  it("accepts a link of exactly 500 characters", async () => {
    const base = "https://agentguard.example.com/";
    const url = base + "a".repeat(500 - base.length);
    expect((await send([stepWith("long-ok", { system: "agentguard", id: "x", url })])).status).toBe(200);
  });

  it("is fine without a link, and shows none", async () => {
    await send([{ runId: "no-link", index: 0, type: "tool", name: "plain", input: "in", output: "out" }]);
    expect((await detailOf("no-link")).body.data.externalRef).toBeNull();
  });

  it("takes links for other systems too", async () => {
    const ref = { system: "stripe", id: "pi_1", url: "https://dashboard.stripe.com/payments/pi_1" };
    expect((await send([stepWith("stripe-ok", ref)])).status).toBe(200);
  });
});

describe("refusing a link that is not safe", () => {
  const good = { system: "agentguard", id: "act_1", url: "https://agentguard.example.com/activity/act_1" };

  it.each([
    ["an http link to another site", { ...good, url: "http://agentguard.example.com/activity/act_1" }],
    ["http://127.0.0.1", { ...good, url: "http://127.0.0.1:5173/x" }],
    ["a javascript: link", { ...good, url: "javascript:alert(1)" }],
    ["a data: link", { ...good, url: "data:text/html,<b>hi</b>" }],
    ["an ftp link", { ...good, url: "ftp://example.com/x" }],
    ["a link with no scheme", { ...good, url: "//example.com/x" }],
    ["a link with a password in it", { ...good, url: "https://user:secret@example.com/x" }],
    ["a link with a key in it", { ...good, url: "https://example.com/x?key=sk-abcdefghijklmnopqrstu" }],
    ["a link of 501 characters", { ...good, url: "https://agentguard.example.com/" + "a".repeat(501 - "https://agentguard.example.com/".length) }],
    ["a capital letter in the system name", { ...good, system: "AgentGuard" }],
    ["a space in the system name", { ...good, system: "agent guard" }],
    ["an empty system name", { ...good, system: "" }],
    ["an empty id", { ...good, id: "  " }],
    ["no url", { system: "agentguard", id: "act_1" }],
    ["a link that is not text", { ...good, url: 42 }],
  ])("refuses %s, and saves nothing from that batch", async (label, ref) => {
    const runId = `bad-${label.replace(/\W+/g, "-")}`;
    const res = await send([stepWith(runId, ref), stepWith(runId, good, 1)]);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(await Run.countDocuments({ appId, externalId: runId })).toBe(0);
  });
});

describe("showing a link", () => {
  it("never shows a saved link that is no longer safe, whatever was saved", async () => {
    const run = await Run.create({ workspaceId: (await Run.findOne({ appId }).lean())!.workspaceId, appId, name: "Old data", stepCount: 2 });
    await Step.insertMany([
      { runId: run._id, index: 0, type: "tool", name: "bad", externalRef: { system: "agentguard", id: "a", url: "javascript:alert(1)" } },
      { runId: run._id, index: 1, type: "tool", name: "http", externalRef: { system: "agentguard", id: "b", url: "http://evil.example.com/x" } },
    ]);
    for (const index of [0, 1]) {
      const res = await request(app).get(`/api/runs/${run._id}/steps/${index}`).set(authed(token));
      expect(res.status).toBe(200);
      expect(res.body.data.externalRef).toBeNull();
    }
  });
});

describe("what a step shows for forking", () => {
  it("offers the last thing an AI step was asked as the text to change, and nothing for tools", async () => {
    const input = JSON.stringify({ model: "gpt-4o-mini", system: "Be kind", messages: [{ role: "user", content: "Refund for order 1042?" }] });
    await send([
      { runId: "prompts", index: 0, type: "llm", name: "answer", model: "gpt-4o-mini", input, output: "Sure." },
      { runId: "prompts", index: 1, type: "llm", name: "by hand", input: "A plain question", output: "A plain answer" },
      { runId: "prompts", index: 2, type: "tool", name: "tool", input: "in", output: "out" },
    ]);
    expect((await detailOf("prompts", 0)).body.data).toMatchObject({ editablePrompt: "Refund for order 1042?", origin: "recorded" });
    expect((await detailOf("prompts", 1)).body.data.editablePrompt).toBe("A plain question");
    expect((await detailOf("prompts", 2)).body.data.editablePrompt).toBeNull();
  });
});
