import { Workspace } from "../../models/workspace.model";
import { logger, serializeError } from "../../utils/logger";
import { setGlobalStorage, syncWorkspaceStorage } from "./storageTotals.service";

// The daily clean-up. Old test results delete themselves in the database without telling anyone, so every workspace's
// all-time total, and the global total, are worked out again from the real data. A total that drifted too high is
// put right, and so is one that drifted too low. One workspace failing never stops the others.
export async function runStorageCleanup() {
  let workspaces = 0;
  let failed = 0;
  let sum = 0;
  for await (const workspace of Workspace.find().select("_id").lean().cursor()) {
    try {
      sum += await syncWorkspaceStorage(workspace._id);
      workspaces += 1;
    } catch (err) {
      failed += 1;
      logger.error("storage clean-up failed for a workspace", serializeError(err));
    }
  }
  // When every workspace was worked out, the global total is simply their sum. (Skipped when one failed: its number is unknown.)
  if (failed === 0) await setGlobalStorage(sum);
  logger.info("storage clean-up done", { workspaces, failed });
  return { workspaces, failed };
}
