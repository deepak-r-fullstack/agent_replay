import { env, parseModelList } from "../src/config/env";
import { MAX_ANSWER_TOKENS } from "../src/constants";
import { ServiceUnavailableError } from "../src/helpers/errors";
import { allowedModels, completeChat, resolveModel, usesDemoProvider } from "../src/services/llm/llmClient";
import { withTimeout } from "../src/utils/timeouts";

// Forks ask an AI model, and with a paid provider that costs the owner money. These tests hold the cost limits that
// need no database: which provider and model are used, how long an answer may be, and how long one call may take.

const original = { ...env };
afterEach(() => {
  Object.assign(env, original);
  jest.restoreAllMocks();
});

const paidOpenAi = (extra: Partial<typeof env> = {}) => Object.assign(env, { LLM_PROVIDER: "openai", LLM_API_KEY: "sk-test-not-a-real-key-1234567890", LLM_MODEL: "gpt-4.1-mini", LLM_ALLOWED_MODELS: [], LLM_BASE_URL: "", ...extra });

function mockFetch(reply: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any>; signal?: AbortSignal }> = [];
  const spy = jest.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
    return { ok: true, status: 200, json: async () => reply };
  }) as never);
  return { calls, spy };
}

const openAiReply = { model: "gpt-4.1-mini-2025-04-14", usage: { prompt_tokens: 20, completion_tokens: 10 }, choices: [{ message: { content: "An answer from a paid model." } }] };
const ask = (model = "gpt-4.1-mini") => ({ model, system: "Be kind", messages: [{ role: "user" as const, content: "Refund for order 1042?" }] });

describe("the list of allowed models", () => {
  it("reads a comma-separated list, ignoring spaces, blanks and repeats", () => {
    expect(parseModelList("gpt-4.1-mini, gpt-4o-mini ,,gpt-4.1-mini,")).toEqual(["gpt-4.1-mini", "gpt-4o-mini"]);
    expect(parseModelList("")).toEqual([]);
    expect(parseModelList("   ")).toEqual([]);
  });

  it("allows the listed models and LLM_MODEL itself", () => {
    paidOpenAi({ LLM_ALLOWED_MODELS: ["gpt-4o-mini"] });
    expect(allowedModels().sort()).toEqual(["gpt-4.1-mini", "gpt-4o-mini"]);
  });

  it("allows only LLM_MODEL when the list is empty", () => {
    paidOpenAi({ LLM_ALLOWED_MODELS: [] });
    expect(allowedModels()).toEqual(["gpt-4.1-mini"]);
  });
});

describe("choosing the model", () => {
  it("uses a model that is on the list, and says nothing", () => {
    paidOpenAi({ LLM_ALLOWED_MODELS: ["gpt-4o-mini"] });
    expect(resolveModel("gpt-4o-mini")).toEqual({ model: "gpt-4o-mini", note: "" });
    expect(resolveModel("  gpt-4o-mini  ")).toEqual({ model: "gpt-4o-mini", note: "" });
    expect(resolveModel("gpt-4.1-mini")).toEqual({ model: "gpt-4.1-mini", note: "" });
  });

  it("replaces a model that is not on the list with LLM_MODEL, and says so in plain words", () => {
    paidOpenAi({ LLM_ALLOWED_MODELS: ["gpt-4o-mini"] });
    expect(resolveModel("gpt-4o")).toEqual({ model: "gpt-4.1-mini", note: "Used gpt-4.1-mini instead of gpt-4o, which is not allowed here." });
    expect(resolveModel("GPT-4O-MINI").note).toMatch(/instead of GPT-4O-MINI/); // names must match exactly
  });

  it("allows only LLM_MODEL when the list is empty", () => {
    paidOpenAi({ LLM_ALLOWED_MODELS: [] });
    expect(resolveModel("gpt-4o-mini")).toEqual({ model: "gpt-4.1-mini", note: "Used gpt-4.1-mini instead of gpt-4o-mini, which is not allowed here." });
    expect(resolveModel("gpt-4.1-mini")).toEqual({ model: "gpt-4.1-mini", note: "" });
  });

  it("uses the provider's default model when LLM_MODEL is not set", () => {
    paidOpenAi({ LLM_MODEL: "", LLM_ALLOWED_MODELS: [] });
    expect(resolveModel("something-pricey")).toEqual({ model: "gpt-4.1-mini", note: "Used gpt-4.1-mini instead of something-pricey, which is not allowed here." });
  });

  it("uses LLM_MODEL without a note when no model was asked for", () => {
    paidOpenAi();
    expect(resolveModel("")).toEqual({ model: "gpt-4.1-mini", note: "" });
    expect(resolveModel("   ")).toEqual({ model: "gpt-4.1-mini", note: "" });
  });

  it("keeps the asked-for name when the free demo model is used, because it costs nothing", () => {
    Object.assign(env, { LLM_PROVIDER: "demo" });
    expect(resolveModel("gpt-4o")).toEqual({ model: "gpt-4o", note: "" });
    paidOpenAi();
    expect(resolveModel("gpt-4o", true)).toEqual({ model: "gpt-4o", note: "" });
    expect(resolveModel("", true).model).toBe("demo-model");
  });

  it("replaces a disallowed model for every paid provider", () => {
    for (const provider of ["openai", "anthropic", "ollama"] as const) {
      Object.assign(env, { LLM_PROVIDER: provider, LLM_API_KEY: "key-1234567890", LLM_MODEL: "the-chosen-one", LLM_ALLOWED_MODELS: [] });
      expect(resolveModel("another-model")).toEqual({ model: "the-chosen-one", note: "Used the-chosen-one instead of another-model, which is not allowed here." });
    }
  });
});

describe("what is sent to a paid provider", () => {
  it("never asks for a model that is not allowed, even if the caller does", async () => {
    paidOpenAi({ LLM_ALLOWED_MODELS: ["gpt-4o-mini"] });
    const { calls } = mockFetch(openAiReply);
    await completeChat(ask("gpt-4o"));
    await completeChat(ask("gpt-4o-mini"));
    expect(calls.map((call) => call.body.model)).toEqual(["gpt-4.1-mini", "gpt-4o-mini"]);
  });

  it("limits the length of every answer: OpenAI itself uses max_completion_tokens", async () => {
    paidOpenAi();
    const { calls } = mockFetch(openAiReply);
    const result = await completeChat(ask());
    expect(calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0].body.max_completion_tokens).toBe(1500);
    expect(calls[0].body).not.toHaveProperty("max_tokens");
    expect(MAX_ANSWER_TOKENS).toBe(1500);
    expect(result).toMatchObject({ text: "An answer from a paid model.", inputTokens: 20, outputTokens: 10, model: "gpt-4.1-mini-2025-04-14" });
  });

  it("limits the length of every answer: an OpenAI-compatible gateway uses max_tokens", async () => {
    paidOpenAi({ LLM_BASE_URL: "https://gateway.example.com/v1" });
    const { calls } = mockFetch(openAiReply);
    await completeChat(ask());
    expect(calls[0].url).toBe("https://gateway.example.com/v1/chat/completions");
    expect(calls[0].body.max_tokens).toBe(1500);
    expect(calls[0].body).not.toHaveProperty("max_completion_tokens");
  });

  it("limits the length of every answer: Claude and Ollama", async () => {
    Object.assign(env, { LLM_PROVIDER: "anthropic", LLM_API_KEY: "key-1234567890", LLM_MODEL: "claude-haiku-4-5", LLM_ALLOWED_MODELS: [] });
    const claude = mockFetch({ model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 3 }, content: [{ type: "text", text: "Hello" }] });
    await completeChat(ask("claude-haiku-4-5"));
    expect(claude.calls[0].body.max_tokens).toBe(1500);
    jest.restoreAllMocks();

    Object.assign(env, { LLM_PROVIDER: "ollama", LLM_MODEL: "llama3.1" });
    const ollama = mockFetch({ model: "llama3.1", message: { content: "Hello" }, prompt_eval_count: 4, eval_count: 2 });
    await completeChat(ask("llama3.1"));
    expect(ollama.calls[0].body.options.num_predict).toBe(1500);
  });

  it("gives each call a deadline it can be stopped at", async () => {
    paidOpenAi();
    const { calls } = mockFetch(openAiReply);
    await completeChat(ask(), { timeoutMs: 5000 });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal!.aborted).toBe(false);
  });
});

describe("knowing when money may have been spent", () => {
  const signal = () => jest.fn();

  it("says so just before a request is sent to a paid provider, even if the provider then fails", async () => {
    paidOpenAi();
    const onProviderCall = signal();
    const spy = jest.spyOn(globalThis, "fetch").mockImplementation((async () => {
      expect(onProviderCall).toHaveBeenCalledTimes(1); // already told, before the request went out
      return { ok: false, status: 500, json: async () => ({}) };
    }) as never);
    await expect(completeChat(ask(), { onProviderCall })).rejects.toThrow(/answered with status 500/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onProviderCall).toHaveBeenCalledTimes(1);
  });

  it("says so for every paid provider", async () => {
    for (const provider of ["openai", "anthropic", "ollama"] as const) {
      Object.assign(env, { LLM_PROVIDER: provider, LLM_API_KEY: "key-1234567890", LLM_MODEL: "the-model", LLM_ALLOWED_MODELS: [], LLM_BASE_URL: "" });
      jest.spyOn(globalThis, "fetch").mockImplementation((async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Hi" } }], content: [{ text: "Hi" }], message: { content: "Hi" } }) })) as never);
      const onProviderCall = signal();
      await completeChat(ask("the-model"), { onProviderCall });
      expect(onProviderCall).toHaveBeenCalledTimes(1);
      jest.restoreAllMocks();
    }
  });

  it("does not say so for the free demo model, whichever way it is chosen", async () => {
    const onProviderCall = signal();
    Object.assign(env, { LLM_PROVIDER: "demo" });
    await completeChat(ask("demo-model"), { onProviderCall });
    paidOpenAi();
    const spy = jest.spyOn(globalThis, "fetch");
    await completeChat(ask("demo-model"), { forceDemo: true, onProviderCall });
    expect(onProviderCall).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not say so when the call fails before anything is sent", async () => {
    Object.assign(env, { LLM_PROVIDER: "openai", LLM_API_KEY: "" });
    const onProviderCall = signal();
    const spy = jest.spyOn(globalThis, "fetch");
    await expect(completeChat(ask(), { onProviderCall })).rejects.toThrow(/AI is not set up/);
    expect(onProviderCall).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the free demo model", () => {
  it("is used for the demo workspace even when a paid provider is set up, and never reaches that provider", async () => {
    paidOpenAi();
    const { spy } = mockFetch(openAiReply);
    expect(usesDemoProvider(true)).toBe(true);
    expect(usesDemoProvider(false)).toBe(false);
    const result = await completeChat({ model: "gpt-4o", messages: [{ role: "user", content: "Refund for order 1042, total ₹2,400" }] }, { forceDemo: true });
    expect(result.text).toContain("order 1042 is ₹2,400");
    expect(result.model).toBe("gpt-4o");
    expect(spy).not.toHaveBeenCalled();
  });

  it("works for the demo workspace even when the paid provider is not set up properly", async () => {
    Object.assign(env, { LLM_PROVIDER: "openai", LLM_API_KEY: "" });
    const { spy } = mockFetch(openAiReply);
    await expect(completeChat(ask(), { forceDemo: true })).resolves.toMatchObject({ text: expect.any(String) });
    expect(spy).not.toHaveBeenCalled();
    // ...while everyone else gets a clear message.
    await expect(completeChat(ask())).rejects.toThrow(/AI is not set up/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the time limit for one AI call", () => {
  it("stops a call that takes too long, with a friendly message", async () => {
    paidOpenAi();
    // A provider that never answers, and honours being stopped.
    jest.spyOn(globalThis, "fetch").mockImplementation(((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as never);
    const started = Date.now();
    const failure = await completeChat(ask(), { timeoutMs: 80 }).catch((error) => error);
    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect(failure.statusCode).toBe(503);
    expect(failure.message).toMatch(/took too long to answer/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("giving up waiting", () => {
  it("passes the result through when the work is quick enough, and fails with the given error when it is not", async () => {
    await expect(withTimeout(Promise.resolve("done"), 500, () => new Error("too slow"))).resolves.toBe("done");
    await expect(withTimeout(new Promise((resolve) => setTimeout(resolve, 300)), 30, () => new Error("too slow"))).rejects.toThrow("too slow");
  });

  it("does not turn a failure that arrives after the time limit into an unhandled error", async () => {
    const late = new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late failure")), 60));
    await expect(withTimeout(late, 10, () => new Error("too slow"))).rejects.toThrow("too slow");
    await new Promise((resolve) => setTimeout(resolve, 120)); // the late failure happens now; the test run must not crash
  });
});
