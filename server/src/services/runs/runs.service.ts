import { FilterQuery, Types } from "mongoose";
import { isProduction } from "../../config/env";
import { DisplayStatus, UNFINISHED_AFTER_MS } from "../../constants";
import { App } from "../../models/app.model";
import { Run, RunDoc } from "../../models/run.model";
import { Step } from "../../models/step.model";
import { isAllowedLinkUrl } from "../../utils/externalRef";
import { editablePromptOf } from "../forks/forkText";

// Reads runs for the screens. A run's saved status is "running", "ok" or "failed". A run that says "running"
// but has had no update for an hour is shown as "unfinished": the app that was recording it has probably stopped.
// That is worked out here, each time, and nothing is changed in the database. If the run does finish later,
// it simply shows its real status again.

// One line of the timeline. The text of the step is fetched when it is opened.
export interface StepOutline {
  index: number;
  type: string;
  name: string;
  model: string;
  tokens: number;
  costUsd: number;
  durationMs: number;
  startedAt: Date;
  origin: string;
  note: string;
  failed: boolean;
}

export const STEP_OUTLINE_PROJECTION = { _id: 0, index: 1, type: 1, name: 1, model: 1, tokens: 1, costUsd: 1, durationMs: 1, startedAt: 1, origin: { $ifNull: ["$origin", "recorded"] }, note: { $ifNull: ["$note", ""] }, failed: { $ne: ["$error", ""] } };

export interface RunListFilters {
  status?: DisplayStatus;
  appId?: string;
  q?: string;
  from?: string; // "2026-10-31", inclusive, UTC
  to?: string; // inclusive, UTC
}

// Runs saved before lastActivityAt existed fall back to when they started.
function lastActivityOf(run: { lastActivityAt?: Date | null; startedAt: Date }) {
  return run.lastActivityAt ?? run.startedAt;
}

export function displayStatusOf(run: { status: string; lastActivityAt?: Date | null; startedAt: Date }, now = new Date()): DisplayStatus {
  if (run.status === "running" && now.getTime() - lastActivityOf(run).getTime() >= UNFINISHED_AFTER_MS) return "unfinished";
  return run.status as DisplayStatus;
}

// "Quiet since before the cutoff", written so that old runs without lastActivityAt still count.
function quietSince(cutoff: Date): FilterQuery<RunDoc>[] {
  return [{ lastActivityAt: { $lt: cutoff } }, { lastActivityAt: { $exists: false }, startedAt: { $lt: cutoff } }];
}

function activeSince(cutoff: Date): FilterQuery<RunDoc>[] {
  return [{ lastActivityAt: { $gte: cutoff } }, { lastActivityAt: { $exists: false }, startedAt: { $gte: cutoff } }];
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildRunFilter(workspaceId: Types.ObjectId, filters: RunListFilters, now = new Date()): FilterQuery<RunDoc> {
  // Always starts with the workspace, so a person only ever sees their own team's runs.
  const conditions: FilterQuery<RunDoc>[] = [{ workspaceId }];
  const cutoff = new Date(now.getTime() - UNFINISHED_AFTER_MS);

  if (filters.status === "ok" || filters.status === "failed") conditions.push({ status: filters.status });
  if (filters.status === "running") conditions.push({ status: "running", $or: activeSince(cutoff) });
  if (filters.status === "unfinished") conditions.push({ status: "running", $or: quietSince(cutoff) });
  if (filters.appId) conditions.push({ appId: new Types.ObjectId(filters.appId) });
  if (filters.q) {
    // Typed text is searched as plain letters, never as a pattern.
    const text = new RegExp(escapeRegExp(filters.q), "i");
    conditions.push({ $or: [{ name: text }, { userRef: text }] });
  }
  if (filters.from) conditions.push({ startedAt: { $gte: new Date(`${filters.from}T00:00:00.000Z`) } });
  if (filters.to) conditions.push({ startedAt: { $lte: new Date(`${filters.to}T23:59:59.999Z`) } });
  return { $and: conditions };
}

export type LeanRun = RunDoc & { createdAt?: Date };

// The same fields in the list and on the replay screen. Never includes anything internal.
export function toRunSummary(run: LeanRun, appNames: Map<string, string>, now: Date) {
  return {
    id: String(run._id),
    name: run.name,
    status: run.status,
    displayStatus: displayStatusOf(run, now),
    userRef: run.userRef,
    model: run.model,
    totalTokens: run.totalTokens,
    costUsd: run.costUsd,
    durationMs: run.durationMs,
    stepCount: run.stepCount,
    tags: run.tags,
    appId: String(run.appId),
    appName: appNames.get(String(run.appId)) ?? "",
    startedAt: run.startedAt,
    lastActivityAt: lastActivityOf(run),
    parentRunId: run.parentRunId ? String(run.parentRunId) : null,
    forkedFromStepId: run.forkedFromStepId ? String(run.forkedFromStepId) : null,
  };
}

export async function appNamesOf(workspaceId: Types.ObjectId) {
  const apps = await App.find({ workspaceId }).select("name").lean();
  return new Map(apps.map((app) => [String(app._id), app.name]));
}

export async function listRuns(workspaceId: Types.ObjectId, filters: RunListFilters, page: number, pageSize: number) {
  const now = new Date();
  const filter = buildRunFilter(workspaceId, filters, now);
  const [runs, total, appNames] = await Promise.all([
    Run.find(filter)
      .sort({ startedAt: -1, _id: -1 }) // _id keeps runs that started at the same moment in a steady order
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<LeanRun[]>(),
    Run.countDocuments(filter),
    appNamesOf(workspaceId),
  ]);
  return { runs: runs.map((run) => toRunSummary(run, appNames, now)), total, page, pageSize };
}

// Returns null when the run is not found in this workspace (also for another team's run).
export async function getRunWithSteps(workspaceId: Types.ObjectId, runId: string) {
  const now = new Date();
  const run = await Run.findOne({ _id: runId, workspaceId }).lean<LeanRun>();
  if (!run) return null;

  const [steps, appNames, parent] = await Promise.all([
    // The timeline only needs the outline of each step. The text (up to 64 KB per step) is fetched one step at a time.
    Step.aggregate<StepOutline>([
      { $match: { runId: run._id } },
      { $sort: { index: 1 } },
      { $project: STEP_OUTLINE_PROJECTION },
    ]),
    appNamesOf(workspaceId),
    run.parentRunId ? Run.findOne({ _id: run.parentRunId, workspaceId }).select("name").lean() : null,
  ]);

  return {
    run: { ...toRunSummary(run, appNames, now), parentRunName: parent?.name ?? null },
    steps,
  };
}

// One step with its full text. Returns null when the run or the step is not found in this workspace.
export async function getStepDetail(workspaceId: Types.ObjectId, runId: string, index: number) {
  const run = await Run.findOne({ _id: runId, workspaceId }).select("_id").lean();
  if (!run) return null;
  const step = await Step.findOne({ runId: run._id, index }).lean();
  if (!step) return null;
  return {
    index: step.index,
    type: step.type,
    name: step.name,
    input: step.input,
    output: step.output,
    model: step.model,
    tokens: step.tokens,
    costUsd: step.costUsd,
    durationMs: step.durationMs,
    error: step.error,
    startedAt: step.startedAt,
    origin: step.origin ?? "recorded",
    note: step.note ?? "",
    // What a person edits when forking an AI step: the last thing the AI was asked.
    editablePrompt: step.type === "llm" ? editablePromptOf(step.input) : null,
    // Shown as a link, so it is checked again here, whatever was saved before.
    externalRef: step.externalRef && isAllowedLinkUrl(step.externalRef.url, isProduction) ? { system: step.externalRef.system, id: step.externalRef.id, url: step.externalRef.url } : null,
  };
}
