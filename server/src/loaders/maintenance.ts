import { MAINTENANCE_CHECK_EVERY_MS, STORAGE_CLEANUP_EVERY_MS } from "../constants";
import { claimJob } from "../services/maintenance/claimJob";
import { runStorageCleanup } from "../services/maintenance/storageCleanup.service";
import { logger, serializeError } from "../utils/logger";

// Starts the housekeeping timer. Every hour it looks at each job, and a job only runs when it is due and this server
// wins the claim. The timer never keeps the process alive and a failing job only logs.
export function startMaintenance() {
  const tick = async () => {
    try {
      if (await claimJob("storage-cleanup", STORAGE_CLEANUP_EVERY_MS)) await runStorageCleanup();
    } catch (err) {
      logger.error("maintenance failed", serializeError(err));
    }
  };
  const first = setTimeout(tick, 60_000); // a minute after start, so a restart does not slow the first requests
  const timer = setInterval(tick, MAINTENANCE_CHECK_EVERY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
