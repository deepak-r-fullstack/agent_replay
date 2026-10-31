import { AnyBulkWriteOperation, Types } from "mongoose";
import { MAX_STEP_ERROR_BYTES, UNTITLED_RUN_NAME } from "../../constants";
import { AppDoc } from "../../models/app.model";
import { Run } from "../../models/run.model";
import { Step } from "../../models/step.model";
import { prepareText } from "../../utils/text";
import { IngestBatch, IngestRun, IngestStep } from "./ingestSchemas";

// Saves a batch of runs and steps sent by the SDK. Built so that batches can arrive late, out of order or twice:
//  - runs and steps are written with upserts, so the same batch sent again changes nothing
//  - steps can arrive before their run does; the run is created as a placeholder and filled in later
//  - a finished run is never taken back to "running" by a late message
//  - the whole batch costs a handful of database calls, not one per step

export interface IngestResult {
  runs: number;
  steps: number;
  newSteps: number;
}

const NAME_LENGTH = 120;
const MODEL_LENGTH = 80;
const TAG_LENGTH = 40;

// A batch may mention the same run twice (a start and an end); later fields win.
function mergeRunUpdates(earlier: IngestRun | undefined, later: IngestRun): IngestRun {
  if (!earlier) return later;
  const merged = { ...earlier, ...later };
  if (earlier.status && earlier.status !== "running" && later.status === "running") merged.status = earlier.status;
  return merged;
}

function buildRunUpsert(app: AppDoc, update: IngestRun, now: Date): AnyBulkWriteOperation {
  const set: Record<string, unknown> = {};
  const setOnInsert: Record<string, unknown> = {
    workspaceId: app.workspaceId,
    appId: app._id,
    externalId: update.id,
    model: "",
    totalTokens: 0,
    costUsd: 0,
    durationMs: 0,
    stepCount: 0,
    parentRunId: null,
    forkedFromStepId: null,
  };

  // Fields the SDK sent are updated every time. Fields it did not send get their starting value only once.
  if (update.name) set.name = prepareText(update.name, 1024).slice(0, NAME_LENGTH);
  else setOnInsert.name = UNTITLED_RUN_NAME;
  if (update.userRef !== undefined) set.userRef = prepareText(update.userRef, 1024).slice(0, NAME_LENGTH);
  else setOnInsert.userRef = "";
  if (update.tags) set.tags = update.tags.map((tag) => prepareText(tag, 512).slice(0, TAG_LENGTH));
  else setOnInsert.tags = [];
  // "running" is only a starting value: it must never overwrite "ok" or "failed".
  if (update.status && update.status !== "running") set.status = update.status;
  else setOnInsert.status = "running";
  if (update.durationMs) set.reportedDurationMs = update.durationMs;
  else setOnInsert.reportedDurationMs = 0;

  return {
    updateOne: {
      filter: { appId: app._id, externalId: update.id },
      // The earliest start time wins, so a placeholder made by an early step is corrected when the real start arrives.
      update: { $set: set, $setOnInsert: setOnInsert, $min: { startedAt: update.startedAt ?? now } },
      upsert: true,
    },
  };
}

function buildStepUpsert(runId: Types.ObjectId, step: IngestStep, now: Date): AnyBulkWriteOperation {
  return {
    updateOne: {
      filter: { runId, index: step.index },
      // Only on insert: a step that already exists is never changed, so a repeated batch is harmless.
      update: {
        $setOnInsert: {
          type: step.type,
          name: prepareText(step.name, 1024).slice(0, NAME_LENGTH),
          input: prepareText(step.input),
          output: prepareText(step.output),
          model: step.model.slice(0, MODEL_LENGTH),
          tokens: step.tokens,
          costUsd: step.costUsd,
          durationMs: step.durationMs,
          error: prepareText(step.error, MAX_STEP_ERROR_BYTES),
          startedAt: step.startedAt ?? now,
        },
      },
      upsert: true,
    },
  };
}

// Two batches creating the same run (or step) at the same instant: one of them hits the unique index.
// Trying once more finds the document the other one made.
function isDuplicateKeyError(err: unknown) {
  const error = err as { code?: number; writeErrors?: Array<{ code?: number }> };
  return error.code === 11000 || (Array.isArray(error.writeErrors) && error.writeErrors.length > 0 && error.writeErrors.every((item) => item.code === 11000));
}

async function bulkWriteOnce<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return write();
  }
}

// Recomputes each run's totals from its steps. Totals only move forward (stepCount can only grow), so a slow
// batch finishing late can never overwrite a newer total with an older one.
async function refreshRunTotals(runIds: Types.ObjectId[]) {
  if (runIds.length === 0) return;
  const [totals, reported] = await Promise.all([
    Step.aggregate<{ _id: Types.ObjectId; tokens: number; costUsd: number; durationMs: number; stepCount: number; models: Array<string | null> }>([
      { $match: { runId: { $in: runIds } } },
      { $sort: { index: 1 } },
      {
        $group: {
          _id: "$runId",
          tokens: { $sum: "$tokens" },
          costUsd: { $sum: "$costUsd" },
          durationMs: { $sum: "$durationMs" },
          stepCount: { $sum: 1 },
          // In step order, so the first AI model used can be picked below.
          models: { $push: { $cond: [{ $and: [{ $eq: ["$type", "llm"] }, { $ne: ["$model", ""] }] }, "$model", null] } },
        },
      },
    ]),
    Run.find({ _id: { $in: runIds } })
      .select("reportedDurationMs")
      .lean(),
  ]);
  const totalsByRun = new Map(totals.map((item) => [String(item._id), item]));

  const ops: AnyBulkWriteOperation[] = reported.map((run) => {
    const item = totalsByRun.get(String(run._id));
    const stepCount = item?.stepCount ?? 0;
    return {
      updateOne: {
        filter: { _id: run._id, stepCount: { $lte: stepCount } },
        update: {
          $set: {
            totalTokens: item?.tokens ?? 0,
            costUsd: item?.costUsd ?? 0,
            stepCount,
            model: item?.models.find((name) => name) ?? "",
            // The SDK's own measurement of the whole run wins; until it arrives, the step times are added up.
            durationMs: run.reportedDurationMs > 0 ? run.reportedDurationMs : (item?.durationMs ?? 0),
          },
        },
      },
    };
  });
  if (ops.length > 0) await Run.bulkWrite(ops, { ordered: false });
}

export async function ingestBatch(app: AppDoc, batch: IngestBatch): Promise<IngestResult> {
  const now = new Date();

  // Every run this batch mentions, whether it sent the run itself or only steps of it.
  const updates = new Map<string, IngestRun>();
  for (const run of batch.runs) updates.set(run.id, mergeRunUpdates(updates.get(run.id), run));
  for (const step of batch.steps) if (!updates.has(step.runId)) updates.set(step.runId, { id: step.runId });

  await bulkWriteOnce(() => Run.bulkWrite([...updates.values()].map((update) => buildRunUpsert(app, update, now)), { ordered: false }));

  // The filter always includes appId, so an app can only ever reach its own runs, whatever ids it sends.
  const runs = await Run.find({ appId: app._id, externalId: { $in: [...updates.keys()] } })
    .select("_id externalId")
    .lean();
  const runIdByExternalId = new Map(runs.map((run) => [run.externalId as string, run._id]));

  let newSteps = 0;
  if (batch.steps.length > 0) {
    const stepOps = batch.steps.flatMap((step) => {
      const runId = runIdByExternalId.get(step.runId);
      return runId ? [buildStepUpsert(runId, step, now)] : [];
    });
    const result = await bulkWriteOnce(() => Step.bulkWrite(stepOps, { ordered: false }));
    newSteps = result.upsertedCount;
  }

  await refreshRunTotals([...runIdByExternalId.values()]);
  return { runs: updates.size, steps: batch.steps.length, newSteps };
}
