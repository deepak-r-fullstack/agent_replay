import { Types } from "mongoose";
import { MAX_TESTS_PER_WORKSPACE } from "../../constants";
import { BadRequestError, ConflictError, NotFoundError } from "../../helpers/errors";
import { Run } from "../../models/run.model";
import { Step } from "../../models/step.model";
import { TestCase, TestCaseDoc } from "../../models/testCase.model";
import { TestResult } from "../../models/testResult.model";
import { isDuplicateKeyError } from "../../utils/mongoErrors";
import { editablePromptOf } from "../forks/forkText";
import { defaultModel, modelChoices } from "../llm/llmClient";

// Saving, listing, changing and deleting tests. Running them is in suite.service.ts.

type LeanTest = TestCaseDoc & { createdAt?: Date };

export interface CheckInput {
  type: "contains" | "not_contains" | "equals" | "max_cost" | "max_ms";
  value: string | number;
}

export function toTestSummary(test: LeanTest) {
  return {
    id: String(test._id),
    name: test.name,
    sourceRunId: String(test.sourceRunId),
    sourceStepIndex: test.sourceStepIndex,
    model: test.model,
    // A short look at what the AI is asked, so a person can tell tests apart.
    prompt: editablePromptOf(test.input).slice(0, 300),
    checks: test.checks.map((check) => ({ type: check.type, value: check.value })),
    lastResult: test.lastResult
      ? {
          suiteRunId: String(test.lastResult.suiteRunId),
          outcome: test.lastResult.outcome,
          change: test.lastResult.change,
          output: test.lastResult.output,
          failedChecks: (test.lastResult.failedChecks ?? []).map((item) => ({ type: item.type, value: item.value, message: item.message })),
          error: test.lastResult.error,
          costUsd: test.lastResult.costUsd,
          durationMs: test.lastResult.durationMs,
          model: test.lastResult.model,
          note: test.lastResult.note,
          ranAt: test.lastResult.ranAt,
        }
      : null,
    createdAt: test.createdAt,
  };
}

// The most recent "Run all tests", counted by how each test changed.
export async function latestSuite(workspaceId: Types.ObjectId) {
  const last = await TestResult.findOne({ workspaceId }).sort({ ranAt: -1 }).select("suiteRunId ranAt model").lean();
  if (!last) return null;
  const counts = await TestResult.aggregate<{ _id: string; count: number }>([{ $match: { suiteRunId: last.suiteRunId } }, { $group: { _id: "$change", count: { $sum: 1 } } }]);
  const byChange = Object.fromEntries(counts.map((item) => [item._id, item.count]));
  return {
    id: String(last.suiteRunId),
    ranAt: last.ranAt,
    model: last.model,
    improved: byChange.improved ?? 0,
    same: byChange.same ?? 0,
    worse: byChange.worse ?? 0,
    new: byChange.new ?? 0,
    notRun: byChange.not_run ?? 0,
    total: counts.reduce((total, item) => total + item.count, 0),
  };
}

export async function listTests(workspaceId: Types.ObjectId, forceDemo: boolean) {
  const [tests, suite] = await Promise.all([TestCase.find({ workspaceId }).sort({ name: 1 }).lean<LeanTest[]>(), latestSuite(workspaceId)]);
  return {
    tests: tests.map(toTestSummary),
    latestSuite: suite,
    // What the model picker on "Run all tests" offers.
    modelChoices: modelChoices(forceDemo),
    defaultModel: defaultModel(forceDemo),
    limits: { maxTests: MAX_TESTS_PER_WORKSPACE },
  };
}

// Saves a test from one AI step of a run (a recorded run or a fork). Returns null when the run is not in this workspace.
export async function createTest(workspaceId: Types.ObjectId, input: { name: string; sourceRunId: string; stepIndex?: number; checks: CheckInput[] }) {
  const run = await Run.findOne({ _id: input.sourceRunId, workspaceId }).select("_id").lean();
  if (!run) throw new NotFoundError("That run was not found.");

  const aiSteps = await Step.find({ runId: run._id, type: "llm" }).sort({ index: 1 }).select("index input model").lean();
  const step = input.stepIndex === undefined ? aiSteps[aiSteps.length - 1] : aiSteps.find((item) => item.index === input.stepIndex);
  if (!step) {
    throw new BadRequestError(input.stepIndex === undefined ? "This run has no AI step to make a test from." : "That step is not an AI step, so it cannot be made into a test.");
  }

  if ((await TestCase.countDocuments({ workspaceId })) >= MAX_TESTS_PER_WORKSPACE) {
    throw new BadRequestError(`You can save up to ${MAX_TESTS_PER_WORKSPACE} tests. Delete one you no longer need first.`);
  }
  try {
    const test = await TestCase.create({ workspaceId, name: input.name, sourceRunId: run._id, sourceStepIndex: step.index, input: step.input, model: step.model, checks: input.checks });
    return toTestSummary(test.toObject() as LeanTest);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ConflictError("You already have a test with this name. Please choose another name.");
    throw err;
  }
}

export async function updateTest(workspaceId: Types.ObjectId, testId: string, changes: { name?: string; checks?: CheckInput[] }) {
  try {
    // Changing the checks starts the test's story again, so an old result is not shown against new checks.
    const test = await TestCase.findOneAndUpdate({ _id: testId, workspaceId }, { $set: changes, ...(changes.checks ? { $unset: { lastResult: "", lastCheckedOutcome: "" } } : {}) }, { new: true }).lean<LeanTest>();
    if (!test) throw new NotFoundError("That test was not found.");
    return toTestSummary(test);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ConflictError("You already have a test with this name. Please choose another name.");
    throw err;
  }
}

export async function deleteTest(workspaceId: Types.ObjectId, testId: string) {
  const test = await TestCase.findOneAndDelete({ _id: testId, workspaceId }).select("_id").lean();
  if (!test) throw new NotFoundError("That test was not found.");
  await TestResult.deleteMany({ testCaseId: test._id });
}
