import { env } from "../src/config/env";
import { evaluateChecks } from "../src/services/tests/checks.service";
import { changeOf } from "../src/services/tests/suite.service";
import { checkSchema, createTestSchema, runSuiteSchema, updateTestSchema } from "../src/services/tests/testSchemas";
import { demoReply } from "../src/services/llm/demoProvider";
import { completeChat } from "../src/services/llm/llmClient";

// The pieces of "tests and suites" that need no database: what each check means, how a change is worked out, what
// may be sent, and the second free demo model that gets the refund wrong.

const ANSWER = "Your refund for order 1042 is ₹2,400. It will reach your original payment method in 3 to 5 working days.";
const facts = { costUsd: 0.002, durationMs: 1500 };

describe("the checks", () => {
  it("passes when everything is as it should be", () => {
    expect(
      evaluateChecks(ANSWER, facts, [
        { type: "contains", value: "₹2,400" },
        { type: "not_contains", value: "₹1,800" },
        { type: "max_cost", value: 0.01 },
        { type: "max_ms", value: 5000 },
      ])
    ).toEqual([]);
  });

  it("looks for words ignoring capital letters, spaces and line breaks", () => {
    expect(evaluateChecks("The  REFUND\nis ready", facts, [{ type: "contains", value: "refund is READY" }])).toEqual([]);
    expect(evaluateChecks("The refund is ready", facts, [{ type: "not_contains", value: "REFUND" }])).toHaveLength(1);
  });

  it("says in plain words what failed", () => {
    const failed = evaluateChecks(ANSWER, { costUsd: 0.5, durationMs: 4200 }, [
      { type: "contains", value: "₹9,999" },
      { type: "not_contains", value: "order 1042" },
      { type: "equals", value: "Something else" },
      { type: "max_cost", value: 0.01 },
      { type: "max_ms", value: 3000 },
    ]);
    expect(failed.map((item) => item.message)).toEqual([
      'The answer should mention "₹9,999", but it does not.',
      'The answer should not mention "order 1042", but it does.',
      'The answer should be exactly "Something else", but it is different.',
      "The answer cost $0.50, but it should cost no more than $0.01.",
      "The answer took 4.2 seconds, but it should take no more than 3 seconds.",
    ]);
    expect(failed[0]).toMatchObject({ type: "contains", value: "₹9,999" });
  });

  it("only passes 'exactly' when the whole answer matches, ignoring extra spaces but not capital letters", () => {
    expect(evaluateChecks("  Yes,   it is.\n", facts, [{ type: "equals", value: "Yes, it is." }])).toEqual([]);
    expect(evaluateChecks("Yes, it is.", facts, [{ type: "equals", value: "yes, it is." }])).toHaveLength(1);
    expect(evaluateChecks("Yes, it is. Really.", facts, [{ type: "equals", value: "Yes, it is." }])).toHaveLength(1);
  });

  it("allows exactly the limit for cost and time, and cannot fail a cost check when no price is known", () => {
    expect(evaluateChecks(ANSWER, { costUsd: 0.01, durationMs: 3000 }, [{ type: "max_cost", value: 0.01 }, { type: "max_ms", value: 3000 }])).toEqual([]);
    expect(evaluateChecks(ANSWER, { costUsd: 0, durationMs: 10 }, [{ type: "max_cost", value: 0.0001 }])).toEqual([]);
  });

  it("shortens very long words in the message", () => {
    const [failed] = evaluateChecks("short", facts, [{ type: "contains", value: "x".repeat(300) }]);
    expect(failed.message.length).toBeLessThan(140);
    expect(failed.message).toContain("...");
  });

  it("reports every failed check, not only the first", () => {
    expect(evaluateChecks("nothing useful", facts, [{ type: "contains", value: "a-b-c" }, { type: "contains", value: "d-e-f" }])).toHaveLength(2);
  });
});

describe("what changed since last time", () => {
  it.each([
    ["passed", "passed", "same"],
    ["failed", "failed", "same"],
    ["passed", "failed", "worse"],
    ["failed", "passed", "improved"],
    [undefined, "passed", "new"],
    [undefined, "failed", "new"],
    [null, "passed", "new"],
    ["passed", "error", "not_run"],
    ["failed", "skipped", "not_run"],
    [undefined, "error", "not_run"],
  ] as const)("last time %s, this time %s: %s", (previous, outcome, change) => {
    expect(changeOf(previous, outcome)).toBe(change);
  });
});

describe("what may be sent", () => {
  it("accepts every kind of check", () => {
    for (const check of [
      { type: "contains", value: "₹2,400" },
      { type: "not_contains", value: " sorry " },
      { type: "equals", value: "Yes" },
      { type: "max_cost", value: 0.05 },
      { type: "max_ms", value: 2500 },
    ]) {
      expect(checkSchema.safeParse(check).success).toBe(true);
    }
    expect(checkSchema.parse({ type: "contains", value: "  trimmed  " }).value).toBe("trimmed");
  });

  it.each([
    ["an empty word", { type: "contains", value: "   " }],
    ["a word that is too long", { type: "contains", value: "x".repeat(501) }],
    ["a number for a words check", { type: "contains", value: 5 }],
    ["words for a cost check", { type: "max_cost", value: "cheap" }],
    ["a cost of zero", { type: "max_cost", value: 0 }],
    ["a negative cost", { type: "max_cost", value: -1 }],
    ["a time of zero", { type: "max_ms", value: 0 }],
    ["a time in fractions of a millisecond", { type: "max_ms", value: 1.5 }],
    ["a time of more than ten minutes", { type: "max_ms", value: 600_001 }],
    ["a kind of check that does not exist", { type: "sounds_nice", value: "x" }],
    ["no kind of check", { value: "x" }],
  ])("refuses %s", (_label, check) => {
    expect(checkSchema.safeParse(check).success).toBe(false);
  });

  const valid = { name: "Refund amount", sourceRunId: "a".repeat(24), checks: [{ type: "contains", value: "₹2,400" }] };

  it("needs a name, a run and at least one check (a test with no checks could never fail)", () => {
    expect(createTestSchema.safeParse(valid).success).toBe(true);
    expect(createTestSchema.safeParse({ ...valid, name: "  " }).success).toBe(false);
    expect(createTestSchema.safeParse({ ...valid, name: "x".repeat(121) }).success).toBe(false);
    expect(createTestSchema.safeParse({ ...valid, sourceRunId: "not-a-run" }).success).toBe(false);
    expect(createTestSchema.safeParse({ ...valid, checks: [] }).success).toBe(false);
    expect(createTestSchema.safeParse({ ...valid, checks: Array.from({ length: 11 }, () => ({ type: "contains", value: "a" })) }).success).toBe(false);
    expect(createTestSchema.safeParse({ ...valid, stepIndex: 1000 }).success).toBe(false);
    expect(createTestSchema.safeParse({ ...valid, stepIndex: -1 }).success).toBe(false);
    expect(createTestSchema.safeParse({ ...valid, stepIndex: 3 }).success).toBe(true);
  });

  it("needs something to change when a test is edited", () => {
    expect(updateTestSchema.safeParse({}).success).toBe(false);
    expect(updateTestSchema.safeParse({ name: "New name" }).success).toBe(true);
    expect(updateTestSchema.safeParse({ checks: [] }).success).toBe(false);
  });

  it("takes an optional model for running all tests", () => {
    expect(runSuiteSchema.parse({})).toEqual({});
    expect(runSuiteSchema.parse({ model: " demo-fast " })).toEqual({ model: "demo-fast" });
    expect(runSuiteSchema.safeParse({ model: "" }).success).toBe(false);
  });
});

describe("the second free demo model", () => {
  const prompt = "Refund for order 1042. Order data: order 1042, total ₹2,400.";

  it("gets the amount right as demo-model and wrong as demo-fast, so a change for the worse can be shown", () => {
    expect(demoReply(prompt)).toContain("₹2,400");
    expect(demoReply(prompt, "demo-model")).toContain("₹2,400");
    expect(demoReply(prompt, "demo-fast")).toContain("₹1,800");
    expect(demoReply(prompt, "demo-fast")).not.toContain("₹2,400");
  });

  it("answers other questions the same way whichever demo model is used", () => {
    expect(demoReply("Please summarise this chat", "demo-fast")).toBe(demoReply("Please summarise this chat", "demo-model"));
    expect(demoReply("What is the weather?", "demo-fast")).toBe(demoReply("What is the weather?"));
  });

  it("is reached through the same client the paid providers use", async () => {
    const answer = await completeChat({ model: "demo-fast", messages: [{ role: "user", content: prompt }] });
    expect(answer.text).toContain("₹1,800");
    expect(answer.model).toBe("demo-fast");
  });
});

describe("what an answer cost", () => {
  const original = { ...env };
  afterEach(() => {
    Object.assign(env, original);
    jest.restoreAllMocks();
  });

  it("is worked out from the prices in the settings, and is nothing when they are not set", async () => {
    Object.assign(env, { LLM_PROVIDER: "openai", LLM_API_KEY: "sk-test-not-a-real-key-1234567890", LLM_MODEL: "gpt-4.1-mini", LLM_ALLOWED_MODELS: [], LLM_BASE_URL: "" });
    jest.spyOn(globalThis, "fetch").mockImplementation((async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: "gpt-4.1-mini", usage: { prompt_tokens: 2000, completion_tokens: 1000 }, choices: [{ message: { content: "Answer" } }] }),
    })) as never);
    const request = { model: "gpt-4.1-mini", messages: [{ role: "user" as const, content: "Hi" }] };

    Object.assign(env, { LLM_INPUT_PRICE_PER_MILLION: 0, LLM_OUTPUT_PRICE_PER_MILLION: 0 });
    expect((await completeChat(request)).costUsd).toBe(0);

    Object.assign(env, { LLM_INPUT_PRICE_PER_MILLION: 0.4, LLM_OUTPUT_PRICE_PER_MILLION: 1.6 });
    expect((await completeChat(request)).costUsd).toBeCloseTo((2000 * 0.4 + 1000 * 1.6) / 1_000_000, 10);
  });

  it("is nothing for the free demo model", async () => {
    Object.assign(env, { LLM_PROVIDER: "demo", LLM_INPUT_PRICE_PER_MILLION: 5, LLM_OUTPUT_PRICE_PER_MILLION: 5 });
    const answer = await completeChat({ model: "demo-model", messages: [{ role: "user", content: "Hi" }] });
    expect(answer.costUsd ?? 0).toBe(0);
  });
});
