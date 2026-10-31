import { Types } from "mongoose";
import { MAX_FORKS_PER_DAY_DEMO_PROVIDER, MAX_FORKS_PER_DAY_REAL_PROVIDER, STORAGE_COUNTER_KEEP_DAYS } from "../../constants";
import { ForkUsage } from "../../models/forkUsage.model";
import { raiseWithinLimit } from "../../utils/atomicCounter";
import { dayKey } from "../ingest/storageQuota.service";

// Each workspace may only start so many forks a day, because every fork asks an AI model. A real (paid) provider gets
// a lower limit than the free scripted demo model. The slot is taken BEFORE any AI call (so a burst of requests cannot
// run up the bill) and given back if the fork does not finish.

export function forkLimitFor(usesDemoProvider: boolean) {
  return usesDemoProvider ? MAX_FORKS_PER_DAY_DEMO_PROVIDER : MAX_FORKS_PER_DAY_REAL_PROVIDER;
}

/** Takes one of today's fork slots. Returns false when the workspace has used them all. */
export async function reserveForkSlot(workspaceId: Types.ObjectId, usesDemoProvider: boolean, now = new Date()) {
  const expiresAt = new Date(now.getTime() + STORAGE_COUNTER_KEEP_DAYS * 24 * 60 * 60 * 1000);
  return raiseWithinLimit(ForkUsage, { workspaceId, day: dayKey(now) }, "count", 1, forkLimitFor(usesDemoProvider), expiresAt);
}

/** Gives a slot back, for a fork that failed or was stopped. */
export async function releaseForkSlot(workspaceId: Types.ObjectId, now = new Date()) {
  await ForkUsage.updateOne({ workspaceId, day: dayKey(now) }, { $inc: { count: -1 } });
}
