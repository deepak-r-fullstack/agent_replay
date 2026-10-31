import { Types } from "mongoose";
import { AI_CALL_TIMEOUT_MS, FORK_NAME_SUFFIX, FORK_TIME_LIMIT_MS, MAX_LLM_STEPS_PER_FORK, MAX_STEP_ERROR_BYTES, RUN_STORAGE_BYTES, StepOrigin } from "../../constants";
import { BadRequestError, NotFoundError, ServiceUnavailableError, TooManyRequestsError } from "../../helpers/errors";
import { Run, RunDoc } from "../../models/run.model";
import { Step, StepDoc } from "../../models/step.model";
import { Workspace } from "../../models/workspace.model";
import { prepareText } from "../../utils/text";
import { withTimeout } from "../../utils/timeouts";
import { assertStorageRoom, releaseStorage } from "../ingest/storageQuota.service";
import { ChatOptions, ChatRequest, ChatResult, completeChat, resolveModel, usesDemoProvider } from "../llm/llmClient";
import { releaseForkSlot, reserveForkSlot } from "./forkQuota.service";
import { applyPromptEdit, applyReplacements, chatRequestFrom, Replacement } from "./forkText";

// A fork is a new run that starts from a step of an existing run:
//   - steps BEFORE the chosen step are copied from the original
//   - AI ("llm") steps from the chosen step onwards are asked again through the AI model
//   - every other step (tool, lookup, custom) is NEVER run. Its recorded result is reused, or the result a person typed.
// Every fork is also held to cost limits, because anyone can start one (including demo visitors):
//   - the demo workspace always uses the free scripted model, whatever LLM_PROVIDER says
//   - with a paid provider only allowed models are used (see resolveModel)
//   - a daily limit of forks per workspace, taken before any AI call and given back only if no paid call was made
//   - each AI call may take 30 seconds and the whole fork 90; past that nothing is saved and nothing is counted
// There is no code in this file that runs a tool: only AI steps reach the AI model, and everything else is copied.
// The original run and its steps are only ever read.

export interface ForkEdit {
  prompt?: string; // AI steps only: what the AI is asked
  model?: string; // AI steps only
  output?: string; // tool, lookup and custom steps only: the result to pretend they gave
}

export interface ForkInput {
  fromStepIndex: number;
  edits: Record<number, ForkEdit>;
}

type LeanStep = StepDoc & { _id: Types.ObjectId };

// What a fork step looks like before it is saved.
interface PlannedStep {
  index: number;
  type: LeanStep["type"];
  name: string;
  input: string;
  output: string;
  model: string;
  tokens: number;
  costUsd: number;
  durationMs: number;
  error: string;
  startedAt: Date;
  origin: StepOrigin;
  note?: string;
  externalRef?: LeanStep["externalRef"];
}

export interface ForkLimits {
  callMs: number; // one AI call
  forkMs: number; // the whole fork
}

const CALL_TOO_LONG = () => new ServiceUnavailableError(`The AI took too long to answer (over ${Math.round(AI_CALL_TIMEOUT_MS / 1000)} seconds), so the fork was stopped. Nothing was saved. Please try again.`);
const FORK_TOO_LONG = () =>
  new ServiceUnavailableError(`This fork took too long (over ${Math.round(FORK_TIME_LIMIT_MS / 1000)} seconds), so it was stopped. Nothing was saved. Try forking from a later step, so fewer AI steps are asked again.`);

type Ask = (request: ChatRequest, options?: ChatOptions) => Promise<ChatResult>;

function checkEdits(steps: LeanStep[], input: ForkInput) {
  const byIndex = new Map(steps.map((step) => [step.index, step]));
  for (const [key, edit] of Object.entries(input.edits)) {
    const index = Number(key);
    const step = byIndex.get(index);
    if (!step) throw new BadRequestError(`Step ${index + 1} does not exist, so it cannot be changed.`);
    if (index < input.fromStepIndex) throw new BadRequestError(`Step ${index + 1} comes before the step you are forking from, so it cannot be changed.`);
    if (step.type === "llm" && edit.output !== undefined) {
      throw new BadRequestError(`Step ${index + 1} is an AI step. Change what the AI is asked or which model it uses; its answer comes from the AI.`);
    }
    if (step.type !== "llm" && (edit.prompt !== undefined || edit.model !== undefined)) {
      throw new BadRequestError(`Step ${index + 1} is not an AI step. You can only change what it returned.`);
    }
  }
}

// Builds every step of the fork, in order. AI steps are asked one after another, because a later question can
// quote an earlier answer.
async function planSteps(steps: LeanStep[], input: ForkInput, ask: Ask, forceDemo: boolean, limits: ForkLimits, deadline: number) {
  const replacements: Replacement[] = [];
  const planned: PlannedStep[] = [];

  for (const step of steps) {
    const base = {
      index: step.index,
      type: step.type,
      name: step.name,
      model: step.model,
      tokens: step.tokens,
      costUsd: step.costUsd,
      durationMs: step.durationMs,
      startedAt: step.startedAt,
    };

    if (step.index < input.fromStepIndex) {
      planned.push({ ...base, input: step.input, output: step.output, error: step.error, origin: "copied", externalRef: step.externalRef });
      continue;
    }

    const edit = input.edits[step.index] ?? {};
    // A step further on that quotes an earlier answer word for word gets the new answer instead.
    let stepInput = applyReplacements(step.input, replacements);

    if (step.type === "llm") {
      if (edit.prompt !== undefined) stepInput = applyPromptEdit(stepInput, edit.prompt);
      // A model that is not allowed here is replaced, and the step says so.
      const { model, note } = resolveModel(edit.model ?? step.model, forceDemo);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw FORK_TOO_LONG();
      // One call may take 30 seconds, but never longer than what is left of the whole fork's time.
      const callMs = Math.min(limits.callMs, remaining);
      const started = Date.now();
      const answer = await withTimeout(ask({ model, ...chatRequestFrom(stepInput) }, { forceDemo, timeoutMs: callMs }), callMs, callMs < limits.callMs ? FORK_TOO_LONG : CALL_TOO_LONG);
      const output = prepareText(answer.text);
      if (output !== step.output) replacements.push({ from: step.output, to: output });
      planned.push({
        ...base,
        input: prepareText(stepInput),
        output,
        model: answer.model || model,
        tokens: answer.inputTokens + answer.outputTokens,
        costUsd: answer.costUsd ?? 0, // from the prices in the settings; 0 when they are not set
        durationMs: Date.now() - started,
        startedAt: new Date(),
        error: "",
        origin: "rerun",
        note,
      });
      continue;
    }

    // Tool, lookup or custom step: it does not run. Its result is reused as recorded, or is the one a person typed.
    if (edit.output !== undefined) {
      const output = prepareText(edit.output);
      if (output !== step.output) replacements.push({ from: step.output, to: output });
      // A person who types a result is asking "what if this had worked", so a recorded failure is not carried over.
      planned.push({ ...base, input: prepareText(stepInput), output, error: "", origin: "edited" });
    } else {
      planned.push({ ...base, input: prepareText(stepInput), output: step.output, error: step.error, origin: "simulated" });
    }
  }
  return planned;
}

const textBytes = (step: PlannedStep) => Buffer.byteLength(step.name) + Buffer.byteLength(step.input) + Buffer.byteLength(step.output) + Buffer.byteLength(step.error);

// Returns the new run. Nothing is saved if anything fails.
export async function forkRun(workspaceId: Types.ObjectId, runId: string, input: ForkInput, ask: Ask = completeChat, limits: ForkLimits = { callMs: AI_CALL_TIMEOUT_MS, forkMs: FORK_TIME_LIMIT_MS }) {
  const startedAt = Date.now();
  const original = await Run.findOne({ _id: runId, workspaceId }).lean<RunDoc & { _id: Types.ObjectId }>();
  if (!original) throw new NotFoundError("That run was not found.");

  const steps = await Step.find({ runId: original._id }).sort({ index: 1 }).lean<LeanStep[]>();
  const forkPoint = steps.find((step) => step.index === input.fromStepIndex);
  if (!forkPoint) throw new BadRequestError("That step does not exist in this run.");
  checkEdits(steps, input);

  const askedAgain = steps.filter((step) => step.index >= input.fromStepIndex && step.type === "llm").length;
  if (askedAgain > MAX_LLM_STEPS_PER_FORK) {
    throw new BadRequestError(`This fork would ask the AI ${askedAgain} times. The limit is ${MAX_LLM_STEPS_PER_FORK}. Fork from a later step.`);
  }

  // The demo workspace is open to anyone, so it never reaches a paid provider.
  const workspace = await Workspace.findById(workspaceId).select("isDemo").lean();
  const forceDemo = Boolean(workspace?.isDemo);

  // One of today's forks is taken BEFORE any AI call, so a burst of requests cannot run up the bill.
  // If the fork then fails, the slot is given back ONLY when no call reached a paid provider. A call that was sent may
  // already have cost money, even if it then timed out, so repeated failures can never get around the daily limit.
  // Calls to the free demo model cost nothing and do not count.
  let paidCallMade = false;
  const askAndNotice: Ask = (request, options) =>
    ask(request, {
      ...options,
      onProviderCall: () => {
        paidCallMade = true;
        options?.onProviderCall?.();
      },
    });
  const now = new Date();
  if (!(await reserveForkSlot(workspaceId, usesDemoProvider(forceDemo), now))) {
    throw new TooManyRequestsError("This workspace has used today's forks. Try again tomorrow.");
  }

  try {
    // May throw 503 when the AI model cannot be reached or takes too long: then nothing has been saved or counted.
    const planned = await withTimeout(planSteps(steps, input, askAndNotice, forceDemo, limits, startedAt + limits.forkMs), Math.max(1, startedAt + limits.forkMs - Date.now()), FORK_TOO_LONG);

    // Forks use the same storage room as recorded runs (the new run itself counts too).
    const bytes = planned.reduce((total, step) => total + textBytes(step), RUN_STORAGE_BYTES);
    await assertStorageRoom(workspaceId, bytes, now);

    const failed = planned.some((step) => step.error);
    const durationMs = planned.reduce((total, step) => total + step.durationMs, 0);
    let forkId: Types.ObjectId | null = null;
    try {
      const fork = await Run.create({
        workspaceId,
        appId: original.appId,
        name: `${original.name}${FORK_NAME_SUFFIX}`.slice(0, 120),
        status: failed ? "failed" : "ok",
        userRef: original.userRef,
        model: planned.find((step) => step.type === "llm" && step.model)?.model ?? "",
        totalTokens: planned.reduce((total, step) => total + step.tokens, 0),
        costUsd: planned.reduce((total, step) => total + step.costUsd, 0),
        durationMs,
        reportedDurationMs: durationMs,
        stepCount: planned.length,
        tags: original.tags,
        parentRunId: original._id,
        forkedFromStepId: forkPoint._id,
        startedAt: now,
        lastActivityAt: now,
      });
      forkId = fork._id;
      await Step.insertMany(planned.map((step) => ({ ...step, runId: fork._id, error: prepareText(step.error, MAX_STEP_ERROR_BYTES) })));
      return fork;
    } catch (err) {
      // Not everything was saved: remove what was, and give the storage room back.
      if (forkId) {
        await Step.deleteMany({ runId: forkId }).catch(() => undefined);
        await Run.deleteOne({ _id: forkId }).catch(() => undefined);
      }
      await releaseStorage(workspaceId, bytes, now).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    if (!paidCallMade) await releaseForkSlot(workspaceId, now).catch(() => undefined);
    throw err;
  }
}
