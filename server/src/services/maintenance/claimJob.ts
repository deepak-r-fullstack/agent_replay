import { MaintenanceLog } from "../../models/maintenanceLog.model";
import { isDuplicateKeyError } from "../../utils/mongoErrors";

// Says "this job is mine to run now" for at most one caller per interval. One atomic update: it matches only when the
// job has not run within `everyMs`. Otherwise it tries to create the job's record, finds it exists (unique name)
// and fails, and that failure means "someone already ran it".
export async function claimJob(name: string, everyMs: number, now = new Date()): Promise<boolean> {
  try {
    await MaintenanceLog.updateOne({ name, lastRunAt: { $lte: new Date(now.getTime() - everyMs) } }, { $set: { lastRunAt: now } }, { upsert: true });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}
