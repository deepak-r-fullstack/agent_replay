import { Types } from "mongoose";
import { DEMO_APP_NAME, DEMO_RESET_EVERY_MS, DEMO_WORKSPACE_NAME, DEMO_WORKSPACE_SLUG, STORAGE_TOTAL_KEY } from "../../constants";
import { env } from "../../config/env";
import { App, AppDoc } from "../../models/app.model";
import { MaintenanceLog } from "../../models/maintenanceLog.model";
import { Run } from "../../models/run.model";
import { Step } from "../../models/step.model";
import { StorageUsage } from "../../models/storageUsage.model";
import { TestCase } from "../../models/testCase.model";
import { TestResult } from "../../models/testResult.model";
import { TestRunUsage } from "../../models/testRunUsage.model";
import { Workspace } from "../../models/workspace.model";
import { logger, serializeError } from "../../utils/logger";
import { generateApiKey } from "../auth/auth.service";
import { forkRun } from "../forks/fork.service";
import { releaseForkSlot } from "../forks/forkQuota.service";
import { ingestBatch } from "../ingest/ingest.service";
import { dayKey, lowerStorage } from "../ingest/storageQuota.service";
import { claimJob } from "../maintenance/claimJob";
import { syncWorkspaceStorage } from "../maintenance/storageTotals.service";
import { createTest } from "../tests/tests.service";
import { runSuite } from "../tests/suite.service";
import { buildDemoStory, DEMO_TESTS, RIGHT_PROMPT, WRONG_RUN_ID, WRONG_STEP_INDEX } from "./demoStory";

// Keeps the shared demo workspace tidy. Visitors can do anything in it (fork, save tests, add apps), so once an hour it is
// wiped and filled again from the same story. Only the demo workspace is ever touched here.

// Finds the demo workspace, or makes it the first time.
export async function ensureDemoWorkspace() {
  return Workspace.findOneAndUpdate(
    { slug: DEMO_WORKSPACE_SLUG },
    { $setOnInsert: { name: DEMO_WORKSPACE_NAME, slug: DEMO_WORKSPACE_SLUG, isDemo: true } },
    { upsert: true, new: true }
  ).lean();
}

/** Wipes the demo workspace's runs, apps and tests and seeds the story again. The counters start from what is really there. */
export async function resetDemoWorkspace(now = new Date()) {
  const workspace = await ensureDemoWorkspace();
  // Never run against a workspace that is not the demo, whatever its slug says.
  if (!workspace?.isDemo) throw new Error("The demo workspace is not marked as a demo.");
  const workspaceId = workspace._id as Types.ObjectId;

  // 1. Wipe what visitors made, and bring the counters down with it so the new story has room.
  const oldTotal = (await StorageUsage.findOne({ workspaceId, day: STORAGE_TOTAL_KEY }).lean())?.bytes ?? 0;
  const runIds = (await Run.find({ workspaceId }).select("_id").lean()).map((run) => run._id);
  await Step.deleteMany({ runId: { $in: runIds } });
  await Run.deleteMany({ workspaceId });
  await TestResult.deleteMany({ workspaceId });
  await TestCase.deleteMany({ workspaceId });
  await App.deleteMany({ workspaceId });
  await lowerStorage(workspaceId, oldTotal);

  // 2. The demo's own app. Nobody knows its key (it is never shown), so only the seed below sends runs to it.
  const { apiKeyHash, apiKeyPreview } = generateApiKey();
  const app = (await App.create({ workspaceId, name: DEMO_APP_NAME, apiKeyHash, apiKeyPreview, seeded: true })).toObject() as AppDoc;

  // 3. The story: five recorded runs, one real fork that fixes the wrong refund, and two saved tests that have been run once.
  await ingestBatch(app, buildDemoStory(env.AGENTGUARD_DEMO_URL, now));
  const wrongRun = await Run.findOne({ appId: app._id, externalId: WRONG_RUN_ID }).select("_id").lean();
  if (!wrongRun) throw new Error("The demo story could not be saved.");
  const fork = await forkRun(workspaceId, String(wrongRun._id), { fromStepIndex: WRONG_STEP_INDEX, edits: { [WRONG_STEP_INDEX]: { prompt: RIGHT_PROMPT } } });
  for (const test of DEMO_TESTS) {
    await createTest(workspaceId, { name: test.name, sourceRunId: String(fork._id), stepIndex: WRONG_STEP_INDEX, checks: test.checks });
  }
  await runSuite(workspaceId, {});

  // 4. The seed is not the visitors' doing: give back the fork and test-run slots it used, start today's storage count
  // again, and set the all-time total to what is really stored.
  await releaseForkSlot(workspaceId, now);
  await TestRunUsage.updateOne({ workspaceId, day: dayKey(now) }, { $inc: { count: -DEMO_TESTS.length } });
  await StorageUsage.deleteMany({ workspaceId, day: { $ne: STORAGE_TOTAL_KEY } });
  await syncWorkspaceStorage(workspaceId);
  logger.info("demo reset", { workspaceId: String(workspaceId) });
}

/** Resets the demo if it was not reset within the last hour. Only one server wins each hour. Never throws. */
export async function resetDemoIfDue(now = new Date()) {
  if (!env.DEMO_MODE || !env.DEMO_AUTO_RESET) return false;
  try {
    if (!(await claimJob("demo-reset", DEMO_RESET_EVERY_MS, now))) return false;
  } catch (err) {
    logger.error("demo reset could not start", serializeError(err));
    return false;
  }
  try {
    await resetDemoWorkspace(now);
    return true;
  } catch (err) {
    logger.error("demo reset failed", serializeError(err));
    // Let the next visitor try again soon instead of waiting a whole hour.
    await MaintenanceLog.updateOne({ name: "demo-reset" }, { $set: { lastRunAt: new Date(0) } }).catch(() => undefined);
    return false;
  }
}
