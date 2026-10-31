import { AgentReplay, wrapAnthropic, wrapOpenAI } from "../src";
import { FetchLike } from "../src/types";

// The promise of the SDK: it can never break or slow the app it runs in.
// Every test below either proves that, or proves what gets sent.

const KEY = `ar_${"0123456789abcdef".repeat(3)}`;
const BASE = "http://agentreplay.test";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { runs: Array<Record<string, unknown>>; steps: Array<Record<string, unknown>> };
}

function recordingFetch(status = 200, retryAfter: string | null = null) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { status, headers: { get: () => retryAfter } };
  };
  return { fetch, calls };
}

function makeClient(fetch: FetchLike, extra: Record<string, unknown> = {}) {
  // Long interval: tests call flush() themselves unless they are about the timer.
  return new AgentReplay({ apiKey: KEY, baseUrl: BASE, fetch, flushIntervalMs: 60_000, timeoutMs: 150, ...extra });
}

const allSteps = (calls: Call[]) => calls.flatMap((call) => call.body.steps);

describe("what gets sent", () => {
  it("sends a run and its steps in one request, with the key, to the ingest address", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const run = client.startRun({ name: "Support chat", userRef: "cust_42", tags: ["refund"] });
    run.step({ type: "retrieval", name: "find_order", input: { id: 1042 }, output: { total: 2400 }, durationMs: 12 });
    run.step({ type: "llm", name: "answer", input: "Refund?", output: "₹2,400", model: "gpt-4o-mini", tokens: 90, costUsd: 0.0004 });
    run.end();
    await client.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/ingest`);
    expect(calls[0].headers["x-api-key"]).toBe(KEY);
    const [update] = calls[0].body.runs;
    expect(update).toMatchObject({ id: run.id, name: "Support chat", userRef: "cust_42", tags: ["refund"], status: "ok" });
    expect(typeof update.durationMs).toBe("number");
    expect(calls[0].body.steps.map((step) => [step.index, step.type, step.name])).toEqual([
      [0, "retrieval", "find_order"],
      [1, "llm", "answer"],
    ]);
    expect(calls[0].body.steps[0].input).toBe('{"id":1042}');
    expect(calls[0].body.steps[1]).toMatchObject({ model: "gpt-4o-mini", tokens: 90, costUsd: 0.0004, runId: run.id });
  });

  it("hides secrets before anything leaves the app", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const run = client.startRun({ name: "Mail to ann@example.com", userRef: "ann@example.com" });
    run.step({
      name: "call",
      input: { prompt: "my card is 4111 1111 1111 1111", headers: { authorization: "Bearer abcdefghijklmnop1234567890" } },
      output: "sk-abcdefghijklmnopqrstu",
      error: new Error("failed for ann@example.com"),
    });
    await client.flush();
    const sent = JSON.stringify(calls);
    expect(sent).not.toMatch(/ann@example\.com|4111|abcdefghijklmnop1234567890|sk-abcdefghijklmnopqrstu/);
    expect(sent).toContain("[card hidden]");
    expect(sent).toContain("[email hidden]");
    expect(sent).toContain("[secret hidden]");
  });

  it("caps every text at 32 KB", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    client.startRun().step({ name: "big", input: "x".repeat(200_000), output: "y".repeat(200_000) });
    await client.flush();
    const [step] = allSteps(calls);
    expect(Buffer.byteLength(String(step.input))).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(String(step.output))).toBeLessThanOrEqual(32 * 1024);
  });

  it("marks a run failed when a step failed, unless told otherwise", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const failing = client.startRun();
    failing.step({ name: "oops", error: "model said no" });
    failing.end();
    const forced = client.startRun();
    forced.step({ name: "oops", error: "model said no" });
    forced.end("ok");
    await client.flush();
    const statusOf = (id: string) => calls.flatMap((call) => call.body.runs).find((run) => run.id === id && run.status !== "running")?.status;
    expect(statusOf(failing.id)).toBe("failed");
    expect(statusOf(forced.id)).toBe("ok");
  });

  it("sends in the background by itself after a short wait", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch, { flushIntervalMs: 20 });
    client.startRun().step({ name: "auto" });
    expect(calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(allSteps(calls)).toHaveLength(1);
  });

  it("splits big queues into requests of at most 500 steps", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch, { maxQueuedSteps: 100_000 });
    const run = client.startRun();
    for (let index = 0; index < 1200; index++) run.step({ name: `s${index}` });
    await client.flush();
    // Steps past the 1000-per-run limit are not recorded at all.
    expect(allSteps(calls)).toHaveLength(1000);
    expect(Math.max(...calls.map((call) => call.body.steps.length))).toBeLessThanOrEqual(500);
  });

  it("keeps steps in the order they started, even when work finishes out of order", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const run = client.startRun();
    const slow = run.trace("tool", "slow", () => new Promise((resolve) => setTimeout(() => resolve("a"), 40)));
    const quick = run.trace("tool", "quick", async () => "b");
    await Promise.all([slow, quick]);
    await client.flush();
    const steps = allSteps(calls);
    expect(steps.find((step) => step.name === "slow")?.index).toBe(0);
    expect(steps.find((step) => step.name === "quick")?.index).toBe(1);
  });
});

describe("the host app is never harmed", () => {
  it("does nothing, and throws nothing, without a key", async () => {
    const { fetch, calls } = recordingFetch();
    const client = new AgentReplay({ apiKey: "", fetch });
    expect(client.enabled).toBe(false);
    const run = client.startRun({ name: "x" });
    run.step({ name: "a" });
    await run.trace("tool", "b", async () => 1);
    run.end();
    await client.flush();
    expect(calls).toHaveLength(0);
  });

  it("does nothing when switched off, or when the key is not an AgentReplay key", async () => {
    const { fetch, calls } = recordingFetch();
    const off = new AgentReplay({ apiKey: KEY, fetch, enabled: false });
    const wrong = new AgentReplay({ apiKey: "sk-not-ours-1234567890", fetch });
    for (const client of [off, wrong]) {
      client.startRun().step({ name: "a" });
      await client.flush();
    }
    expect(calls).toHaveLength(0);
  });

  it("returns immediately and never waits for the network, even if the server never answers", async () => {
    const hang: FetchLike = () => new Promise(() => undefined);
    const client = makeClient(hang);
    const run = client.startRun({ name: "slow server" });
    const started = Date.now();
    for (let index = 0; index < 900; index++) run.step({ name: `s${index}`, input: { index } });
    run.end();
    expect(Date.now() - started).toBeLessThan(1000);
    // Sending gives up after the short timeout instead of waiting forever.
    const flushStarted = Date.now();
    await client.flush();
    expect(Date.now() - flushStarted).toBeLessThan(2000);
  });

  it("drops data quietly when the server is down, and never throws", async () => {
    const down: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = makeClient(down);
    const run = client.startRun();
    run.step({ name: "a" });
    run.end();
    await expect(client.flush()).resolves.toBeUndefined();
    await expect(run.flush()).resolves.toBeUndefined();
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it("copes with a network call that throws straight away instead of returning a promise", async () => {
    const broken = (() => {
      throw new Error("sync failure");
    }) as unknown as FetchLike;
    const client = makeClient(broken);
    client.startRun().step({ name: "a" });
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("prints nothing unless debug is on", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const down: FetchLike = async () => ({ status: 500 });
    const client = makeClient(down);
    for (let round = 0; round < 4; round++) {
      client.startRun().step({ name: "a" });
      await client.flush();
    }
    new AgentReplay({ apiKey: "" });
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it("pauses after repeated failures and drops what arrives meanwhile, so memory cannot pile up", async () => {
    let attempts = 0;
    const down: FetchLike = async () => {
      attempts += 1;
      return { status: 503 };
    };
    const client = makeClient(down);
    for (let round = 0; round < 3; round++) {
      client.startRun().step({ name: "a" });
      await client.flush();
    }
    expect(attempts).toBe(3);
    const run = client.startRun();
    for (let index = 0; index < 50; index++) run.step({ name: `s${index}` });
    await expect(client.flush()).resolves.toBeUndefined();
    expect(attempts).toBe(3); // paused: no new attempts
  });

  it("never holds more than the queue limit, even if sending is stuck", () => {
    const hang: FetchLike = () => new Promise(() => undefined);
    const client = makeClient(hang, { maxQueuedSteps: 50 });
    const run = client.startRun();
    for (let index = 0; index < 100; index++) run.step({ name: `s${index}` });
    expect((client as unknown as { transport: { queuedSteps: number } }).transport.queuedSteps).toBeLessThanOrEqual(50);
  });

  it("stops for good when the key is refused", async () => {
    const { fetch, calls } = recordingFetch(401);
    const client = makeClient(fetch);
    client.startRun().step({ name: "a" });
    await client.flush();
    client.startRun().step({ name: "b" });
    await client.flush();
    expect(calls).toHaveLength(1);
  });

  it("backs off when told it is sending too much", async () => {
    const { fetch, calls } = recordingFetch(429, "120");
    const client = makeClient(fetch);
    client.startRun().step({ name: "a" });
    await client.flush();
    client.startRun().step({ name: "b" });
    await client.flush();
    expect(calls).toHaveLength(1);
  });

  it("drops a batch the server says is bad, then keeps going", async () => {
    let status = 400;
    const calls: number[] = [];
    const fetch: FetchLike = async () => {
      calls.push(status);
      return { status };
    };
    const client = makeClient(fetch);
    client.startRun().step({ name: "bad batch" });
    await client.flush();
    status = 200;
    client.startRun().step({ name: "good batch" });
    await client.flush();
    expect(calls).toEqual([400, 200]);
  });

  it("gives back the host's result, and the host's own error, exactly as they were", async () => {
    const { fetch } = recordingFetch();
    const client = makeClient(fetch);
    const run = client.startRun();
    const result = { answer: 42 };
    expect(await run.trace("tool", "ok", async () => result)).toBe(result);
    const failure = new TypeError("host error");
    await expect(
      run.trace("tool", "fails", () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });

  it("records a failed traced call as a failed step", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const run = client.startRun();
    await run.trace("tool", "lookup", async () => Promise.reject(new Error("order not found")), { input: { id: 7 } }).catch(() => undefined);
    run.end();
    await client.flush();
    const [step] = allSteps(calls);
    expect(step.error).toBe("Error: order not found");
    expect(step.input).toBe('{"id":7}');
  });

  it("is not broken by a faulty output function, or by odd values", async () => {
    const { fetch } = recordingFetch();
    const client = makeClient(fetch);
    const run = client.startRun({ tags: Array.from({ length: 50 }, (_, index) => `t${index}`) });
    const circular: Record<string, unknown> = {};
    circular.me = circular;
    const value = await run.trace("custom", "odd", async () => circular, {
      output: () => {
        throw new Error("my own bug");
      },
    });
    expect(value).toBe(circular);
    expect(() =>
      run.step({ name: "weird", input: circular, output: BigInt(1), tokens: Number.NaN, costUsd: -5, durationMs: Infinity, model: 5 as unknown as string })
    ).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("sends nothing twice when flushed twice", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    client.startRun().step({ name: "a" });
    await Promise.all([client.flush(), client.flush()]);
    await client.flush();
    expect(allSteps(calls)).toHaveLength(1);
  });
});

describe("wrapOpenAI", () => {
  const openAiResponse = {
    model: "gpt-4o-mini-2024",
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
    choices: [{ message: { content: "Your refund is ₹2,400." } }],
  };

  function fakeOpenAI(behaviour: (body: unknown) => unknown) {
    const state = { counter: 0 };
    return {
      apiKeyLabel: "private",
      chat: {
        completions: {
          create(body?: unknown) {
            state.counter += 1;
            return behaviour(body);
          },
        },
      },
      models: { list: () => "untouched" },
      state,
    };
  }

  it("records the call and returns the very same response", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const run = client.startRun();
    const ai = wrapOpenAI(
      fakeOpenAI(async () => openAiResponse),
      run,
      { price: { inputPerMillion: 1, outputPerMillion: 2 } }
    );
    const request = { model: "gpt-4o-mini", messages: [{ role: "user", content: "Refund for order 1042?" }] };
    const response = await ai.chat.completions.create(request);
    expect(response).toBe(openAiResponse);
    run.end();
    await client.flush();
    const [step] = allSteps(calls);
    expect(step).toMatchObject({ type: "llm", name: "chat.completions.create", model: "gpt-4o-mini-2024", tokens: 1500, output: "Your refund is ₹2,400." });
    expect(step.costUsd).toBeCloseTo(0.002, 6);
    expect(String(step.input)).toContain("Refund for order 1042?");
  });

  it("leaves everything else on the client alone", () => {
    const { fetch } = recordingFetch();
    const client = makeClient(fetch);
    const ai = wrapOpenAI(
      fakeOpenAI(async () => openAiResponse),
      client.startRun()
    );
    expect(ai.models.list()).toBe("untouched");
    expect(ai.apiKeyLabel).toBe("private");
  });

  it("throws the very same error as the original call, and records it as a failed step", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const run = client.startRun();
    const failure = new Error("rate limited");
    const ai = wrapOpenAI(
      fakeOpenAI(() => Promise.reject(failure)),
      run
    );
    await expect(ai.chat.completions.create({ model: "m", messages: [] })).rejects.toBe(failure);
    const syncFailure = new Error("bad arguments");
    const syncAi = wrapOpenAI(
      fakeOpenAI(() => {
        throw syncFailure;
      }),
      run
    );
    expect(() => syncAi.chat.completions.create({ model: "m", messages: [] })).toThrow(syncFailure);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.flush();
    expect(allSteps(calls).map((step) => step.error)).toEqual(["Error: rate limited", "Error: bad arguments"]);
  });

  it("still works when the response looks nothing like OpenAI's", async () => {
    const { fetch } = recordingFetch();
    const client = makeClient(fetch);
    const strange = ["not", "an", "object"];
    const ai = wrapOpenAI(
      fakeOpenAI(async () => strange),
      client.startRun()
    );
    expect(await ai.chat.completions.create({ model: "m", messages: [] })).toBe(strange);
    const empty = wrapOpenAI(
      fakeOpenAI(() => null),
      client.startRun()
    );
    expect(empty.chat.completions.create({ model: "m", messages: [] })).toBeNull();
  });

  it("keeps extra methods of the returned promise working", async () => {
    const { fetch } = recordingFetch();
    const client = makeClient(fetch);
    const apiPromise = Object.assign(Promise.resolve(openAiResponse), { withResponse: () => "extra" });
    const ai = wrapOpenAI(
      fakeOpenAI(() => apiPromise),
      client.startRun()
    );
    const result = ai.chat.completions.create({ model: "m", messages: [] }) as typeof apiPromise;
    expect(result).toBe(apiPromise);
    expect(result.withResponse()).toBe("extra");
    await result;
  });

  it("passes streaming calls through without recording them", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const stream = { streaming: true };
    const ai = wrapOpenAI(
      fakeOpenAI(async () => stream),
      client.startRun()
    );
    expect(await ai.chat.completions.create({ model: "m", messages: [], stream: true })).toBe(stream);
    await client.flush();
    expect(allSteps(calls)).toHaveLength(0);
  });

  it("does not break a frozen client (it simply cannot record it)", async () => {
    const { fetch } = recordingFetch();
    const client = makeClient(fetch);
    const frozen = Object.freeze({
      chat: Object.freeze({ completions: Object.freeze({ create: async (_body?: unknown) => openAiResponse }) }),
    });
    const ai = wrapOpenAI(frozen, client.startRun());
    expect(await ai.chat.completions.create({})).toBe(openAiResponse);
  });
});

describe("wrapAnthropic", () => {
  it("records the call, the text and the tokens, and returns the same response", async () => {
    const { fetch, calls } = recordingFetch();
    const client = makeClient(fetch);
    const response = {
      model: "claude-haiku",
      usage: { input_tokens: 200, output_tokens: 50 },
      content: [{ type: "text", text: "Refund is ₹2,400." }],
    };
    const ai = wrapAnthropic({ messages: { create: async (_body?: unknown) => response } }, client.startRun(), { name: "support answer" });
    expect(await ai.messages.create({ model: "claude-haiku", system: "Be kind", messages: [{ role: "user", content: "hi" }] })).toBe(response);
    await client.flush();
    const [step] = allSteps(calls);
    expect(step).toMatchObject({ name: "support answer", model: "claude-haiku", tokens: 250, output: "Refund is ₹2,400." });
    expect(String(step.input)).toContain("Be kind");
  });
});
