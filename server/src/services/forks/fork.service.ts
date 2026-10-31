import { Types } from "mongoose";
import { FORK_NAME_SUFFIX, MAX_LLM_STEPS_PER_FORK, MAX_STEP_ERROR_BYTES, StepOrigin } from "../../constants";
import { BadRequestError, NotFoundError } from "../../helpers/errors";
import { Run, RunDoc } from "../../models/run.model";
import { Step, StepDoc } from "../../models/step.model";
import { prepareText } from "../../utils/text";
import { assertStorageRoom, releaseStorage } from "../ingest/storageQuota.service";
import { ChatResult, completeChat } from "../llm/llmClient";
import { applyPromptEdit, applyReplacements, chatRequestFrom, Replacement } from "./forkText";

// A fork is a new run that starts from a step of an existing run:
//   - steps BEFORE the chosen step are copied from the original
//   - AI ("llm") steps from the chosen step onwards are asked again through the AI model
//   - every other step (tool, lookup, custom) is NEVER run. Its recorded result is reused, or the result a person typed.
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
  externalRef?: LeanStep["externalRef"];
}

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
async function planSteps(steps: LeanStep[], input: ForkInput, ask: (request: Parameters<typeof completeChat>[0]) => Promise<ChatResult>) {
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
      const model = edit.model ?? step.model;
      const started = Date.now();
      const answer = await ask({ model, ...chatRequestFrom(stepInput) });
      const output = prepareText(answer.text);
      if (output !== step.output) replacements.push({ from: step.output, to: output });
      planned.push({
        ...base,
        input: prepareText(stepInput),
        output,
        model: answer.model || model,
        tokens: answer.inputTokens + answer.outputTokens,
        costUsd: 0, // the AI model reports tokens, not prices
        durationMs: Date.now() - started,
        startedAt: new Date(),
        error: "",
        origin: "rerun",
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
export async function forkRun(workspaceId: Types.ObjectId, runId: string, input: ForkInput, ask = completeChat) {
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

  // May throw 503 when the AI model cannot be reached: then nothing has been saved and nothing has been counted.
  const planned = await planSteps(steps, input, ask);

  // Forks use the same storage room as recorded runs.
  const now = new Date();
  const bytes = planned.reduce((total, step) => total + textBytes(step), 0);
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
}
