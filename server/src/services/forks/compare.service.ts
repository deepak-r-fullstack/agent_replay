import { Types } from "mongoose";
import { isProduction } from "../../config/env";
import { AGENTGUARD_SYSTEM } from "../../constants";
import { BadRequestError, NotFoundError } from "../../helpers/errors";
import { Run } from "../../models/run.model";
import { Step } from "../../models/step.model";
import { isAllowedLinkUrl } from "../../utils/externalRef";
import { appNamesOf, LeanRun, STEP_OUTLINE_PROJECTION, StepOutline, toRunSummary } from "../runs/runs.service";

// Everything the Fork compare screen needs: the original run and the fork side by side, step by step,
// and the actions in AgentGuard that the original run caused (so a person can undo them THERE).
// This only reads. AgentReplay never calls AgentGuard: undo stays in AgentGuard, behind its own permissions and audit trail.

async function outlineOf(runId: Types.ObjectId) {
  return Step.aggregate<StepOutline>([{ $match: { runId } }, { $sort: { index: 1 } }, { $project: STEP_OUTLINE_PROJECTION }]);
}

// Returns null when the run is not found in this workspace (also for another team's run).
export async function getComparison(workspaceId: Types.ObjectId, forkId: string) {
  const now = new Date();
  const fork = await Run.findOne({ _id: forkId, workspaceId }).lean<LeanRun & { _id: Types.ObjectId }>();
  if (!fork) return null;
  if (!fork.parentRunId) throw new BadRequestError("This run is not a fork, so there is nothing to compare it with.");
  const original = await Run.findOne({ _id: fork.parentRunId, workspaceId }).lean<LeanRun & { _id: Types.ObjectId }>();
  if (!original) throw new NotFoundError("The run this fork came from is no longer available.");

  const [originalSteps, forkSteps, appNames, linkedSteps] = await Promise.all([
    outlineOf(original._id),
    outlineOf(fork._id),
    appNamesOf(workspaceId),
    Step.find({ runId: original._id, "externalRef.system": AGENTGUARD_SYSTEM }).sort({ index: 1 }).select("index name externalRef").lean(),
  ]);

  // A step only counts as changed when its text really is different: asking the AI the same thing and getting the
  // same answer is not a change. Only steps the fork asked again or a person edited can differ, so only those are read.
  const candidates = forkSteps.filter((step) => step.origin === "rerun" || step.origin === "edited").map((step) => step.index);
  const changed = new Set<number>();
  if (candidates.length > 0) {
    const texts = await Step.find({ runId: { $in: [original._id, fork._id] }, index: { $in: candidates } })
      .select("runId index input output error")
      .lean();
    const byKey = new Map(texts.map((step) => [`${step.runId}:${step.index}`, step]));
    for (const index of candidates) {
      const before = byKey.get(`${original._id}:${index}`);
      const after = byKey.get(`${fork._id}:${index}`);
      if (!before || !after || before.input !== after.input || before.output !== after.output || before.error !== after.error) changed.add(index);
    }
  }

  const originalByIndex = new Map(originalSteps.map((step) => [step.index, step]));
  const forkByIndex = new Map(forkSteps.map((step) => [step.index, step]));
  const indexes = [...new Set([...originalByIndex.keys(), ...forkByIndex.keys()])].sort((a, b) => a - b);
  const rows = indexes.map((index) => {
    const after = forkByIndex.get(index) ?? null;
    const before = originalByIndex.get(index) ?? null;
    return { index, type: (after ?? before)!.type, name: (after ?? before)!.name, origin: after?.origin ?? null, changed: changed.has(index), original: before, fork: after };
  });

  const forkedFromIndex = forkSteps.find((step) => step.origin !== "copied")?.index ?? 0;
  const parentName = original.name;

  return {
    original: toRunSummary(original, appNames, now),
    fork: { ...toRunSummary(fork, appNames, now), parentRunName: parentName },
    forkedFromIndex,
    rows,
    // Only AgentGuard links, and only links that are safe to open (checked again here, whatever was saved before).
    undoLinks: linkedSteps
      .filter((step) => step.externalRef && isAllowedLinkUrl(step.externalRef.url, isProduction))
      .map((step) => ({ index: step.index, name: step.name, id: step.externalRef!.id, url: step.externalRef!.url })),
  };
}
