import { AnyBulkWriteOperation, Types } from "mongoose";
import {
  AI_CALL_TIMEOUT_MS,
  MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER,
  MAX_TEST_AI_CALLS_PER_DAY_REAL_PROVIDER,
  MAX_TEST_OUTPUT_BYTES,
  RESULT_CHANGES,
  ResultChange,
  ResultOutcome,
  STORAGE_COUNTER_KEEP_DAYS,
  SUITE_TIME_LIMIT_MS,
  TEST_CONCURRENCY,
} from "../../constants";
import { AppError, BadRequestError, ServiceUnavailableError, TooManyRequestsError } from "../../helpers/errors";
import { TestCase, TestCaseDoc } from "../../models/testCase.model";
import { TestResult } from "../../models/testResult.model";
import { TestRunUsage } from "../../models/testRunUsage.model";
import { Workspace } from "../../models/workspace.model";
import { raiseWithinLimit } from "../../utils/atomicCounter";
import { prepareText } from "../../utils/text";
import { withTimeout } from "../../utils/timeouts";
import { chatRequestFrom } from "../forks/forkText";
import { assertStorageRoom, dayKey, releaseStorage } from "../ingest/storageQuota.service";
import { ChatOptions, ChatRequest, ChatResult, completeChat, modelChoices, resolveModel, usesDemoProvider } from "../llm/llmClient";
import { evaluateChecks, FailedCheck } from "./checks.service";
import { latestSuite } from "./tests.service";

// "Run all tests": every saved test asks the AI its question again and checks the answer. Each result is compared with
// that test's previous result, so the summary says what got better, stayed the same, or got worse.
// It asks the AI, so it is held to the same cost limits as forks: the demo workspace always uses the free model, only
// allowed models are used, answers are capped, each call may take 30 seconds, and the whole run 90. On top of that,
// a workspace has a daily limit of AI calls for test runs, and at most 20 tests, so one run is at most 20 calls.

export interface SuiteLimits {
  callMs: number; // one AI call
  suiteMs: number; // the whole run
}

type Ask = (request: ChatRequest, options?: ChatOptions) => Promise<ChatResult>;
type LeanTest = TestCaseDoc & { _id: Types.ObjectId };

interface TestOutcome {
  outcome: ResultOutcome;
  change: ResultChange;
  output: string;
  failedChecks: FailedCheck[];
  error: string;
  costUsd: number;
  tokens: number;
  durationMs: number;
  model: string;
  note: string;
}

export function testRunLimitFor(usesDemoModel: boolean) {
  return usesDemoModel ? MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER : MAX_TEST_AI_CALLS_PER_DAY_REAL_PROVIDER;
}

// How this answer compares with the test's last run that really made the checks.
export function changeOf(previous: "passed" | "failed" | undefined | null, outcome: ResultOutcome): ResultChange {
  if (outcome === "error" || outcome === "skipped") return "not_run";
  if (!previous) return "new";
  if (previous === outcome) return "same";
  return outcome === "passed" ? "improved" : "worse";
}

const TIME_UP = "The time for running all tests ran out before this one was asked. Run all tests again.";

async function runOne(test: LeanTest, model: string | undefined, forceDemo: boolean, ask: Ask, limits: SuiteLimits, deadline: number): Promise<TestOutcome> {
  const { model: used, note } = resolveModel(model ?? test.model, forceDemo);
  const skipped: TestOutcome = { outcome: "skipped", change: "not_run", output: "", failedChecks: [], error: TIME_UP, costUsd: 0, tokens: 0, durationMs: 0, model: used, note };
  const remaining = deadline - Date.now();
  if (remaining <= 0) return skipped;

  const callMs = Math.min(limits.callMs, remaining);
  const started = Date.now();
  try {
    const answer = await withTimeout(
      ask({ model: used, ...chatRequestFrom(test.input) }, { forceDemo, timeoutMs: callMs }),
      callMs,
      () => new ServiceUnavailableError(`The AI took too long to answer (over ${Math.round(AI_CALL_TIMEOUT_MS / 1000)} seconds), so this test was stopped.`)
    );
    const durationMs = Date.now() - started;
    const costUsd = answer.costUsd ?? 0;
    const failedChecks = evaluateChecks(answer.text, { costUsd, durationMs }, test.checks.map((check) => ({ type: check.type, value: check.value as string | number })));
    const outcome: ResultOutcome = failedChecks.length > 0 ? "failed" : "passed";
    return {
      outcome,
      change: changeOf(test.lastCheckedOutcome, outcome),
      // The checks looked at the whole answer; only a short, masked copy is kept.
      output: prepareText(answer.text, MAX_TEST_OUTPUT_BYTES),
      failedChecks,
      error: "",
      costUsd,
      tokens: answer.inputTokens + answer.outputTokens,
      durationMs,
      model: answer.model || used,
      note,
    };
  } catch (err) {
    return { ...skipped, outcome: "error", error: err instanceof AppError ? err.message : "The AI could not be asked. Please try again.", durationMs: Date.now() - started };
  }
}

/** Asks the AI every test's question, checks the answers, saves the results and says what changed. */
export async function runSuite(workspaceId: Types.ObjectId, options: { model?: string }, ask: Ask = completeChat, limits: SuiteLimits = { callMs: AI_CALL_TIMEOUT_MS, suiteMs: SUITE_TIME_LIMIT_MS }) {
  const startedAt = Date.now();
  const tests = await TestCase.find({ workspaceId }).sort({ name: 1 }).lean<LeanTest[]>();
  if (tests.length === 0) throw new BadRequestError("You have no tests yet. Open a run and choose Save as test first.");

  // The demo workspace is open to anyone, so it never reaches a paid provider.
  const workspace = await Workspace.findById(workspaceId).select("isDemo").lean();
  const forceDemo = Boolean(workspace?.isDemo);
  if (options.model && !modelChoices(forceDemo).includes(options.model)) {
    throw new BadRequestError("That model is not available here. Pick one from the list.");
  }

  // Room is taken BEFORE any AI call: today's AI calls for test runs, and the storage the results will use.
  const now = new Date();
  const day = dayKey(now);
  const expiresAt = new Date(now.getTime() + STORAGE_COUNTER_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const callsLimit = testRunLimitFor(usesDemoProvider(forceDemo));
  if (!(await raiseWithinLimit(TestRunUsage, { workspaceId, day }, "count", tests.length, callsLimit, expiresAt))) {
    throw new TooManyRequestsError("This workspace has used today's test runs. Try again tomorrow.");
  }
  const giveBackCalls = (count: number) => TestRunUsage.updateOne({ workspaceId, day }, { $inc: { count: -count } }).catch(() => undefined);
  const reservedBytes = tests.length * MAX_TEST_OUTPUT_BYTES;
  try {
    await assertStorageRoom(workspaceId, reservedBytes, now);
  } catch (err) {
    await giveBackCalls(tests.length);
    throw err;
  }

  const deadline = startedAt + limits.suiteMs;
  const outcomes: TestOutcome[] = new Array(tests.length);
  let next = 0;
  // A few tests are asked at the same time, so a run does not take as long as all the answers one after another.
  const worker = async () => {
    for (;;) {
      const position = next++;
      if (position >= tests.length) return;
      outcomes[position] = await runOne(tests[position], options.model, forceDemo, ask, limits, deadline);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, tests.length) }, worker));

  const suiteRunId = new Types.ObjectId();
  const ranAt = new Date();
  await TestResult.insertMany(
    tests.map((test, position) => ({ workspaceId, testCaseId: test._id, suiteRunId, passed: outcomes[position].outcome === "passed", ranAt, ...outcomes[position] }))
  );
  const updates: AnyBulkWriteOperation[] = tests.map((test, position) => {
    const result = outcomes[position];
    return {
      updateOne: {
        filter: { _id: test._id },
        update: {
          $set: {
            lastResult: { suiteRunId, ranAt, ...result },
            // Only a result that really made the checks is what the next run is compared with.
            ...(result.outcome === "passed" || result.outcome === "failed" ? { lastCheckedOutcome: result.outcome } : {}),
          },
        },
      },
    };
  });
  await TestCase.bulkWrite(updates);

  // Tests that were never asked (time ran out) did not use their share of the room, so it is given back.
  const notAsked = outcomes.filter((result) => result.outcome === "skipped").length;
  if (notAsked > 0) {
    await giveBackCalls(notAsked);
    await releaseStorage(workspaceId, notAsked * MAX_TEST_OUTPUT_BYTES, now).catch(() => undefined);
  }

  const counts = Object.fromEntries(RESULT_CHANGES.map((change) => [change, outcomes.filter((result) => result.change === change).length]));
  return {
    suite: await latestSuite(workspaceId),
    summary: { total: tests.length, improved: counts.improved, same: counts.same, worse: counts.worse, new: counts.new, notRun: counts.not_run },
    results: tests.map((test, position) => ({
      testId: String(test._id),
      name: test.name,
      outcome: outcomes[position].outcome,
      change: outcomes[position].change,
      failedChecks: outcomes[position].failedChecks.map((item) => ({ type: item.type, value: item.value, message: item.message })),
      error: outcomes[position].error,
      model: outcomes[position].model,
      note: outcomes[position].note,
    })),
  };
}
