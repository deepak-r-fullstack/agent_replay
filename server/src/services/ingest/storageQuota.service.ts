import { Types } from "mongoose";
import {
  MAX_BYTES_PER_DEMO_WORKSPACE_PER_DAY,
  MAX_BYTES_PER_WORKSPACE_PER_DAY,
  MAX_BYTES_PER_WORKSPACE_TOTAL,
  STORAGE_COUNTER_KEEP_DAYS,
  STORAGE_TOTAL_KEY,
} from "../../constants";
import { TooManyRequestsError } from "../../helpers/errors";
import { StorageUsage } from "../../models/storageUsage.model";
import { Workspace } from "../../models/workspace.model";
import { isDuplicateKeyError } from "../../utils/mongoErrors";

// Keeps one workspace from filling the shared free database. Each check is one small update on a counter
// document (no scan of steps). The counter is only raised if the new total stays within the limit, and that
// check and the raise happen in the same atomic step, so many batches at once cannot slip past the limit.

export type QuotaRefusal = "day" | "total";

export function dayKey(now: Date) {
  return now.toISOString().slice(0, 10); // the UTC date, "2026-10-31"
}

export function dailyLimitFor(isDemo: boolean) {
  return isDemo ? MAX_BYTES_PER_DEMO_WORKSPACE_PER_DAY : MAX_BYTES_PER_WORKSPACE_PER_DAY;
}

// Adds `bytes` to one counter if the result stays within `limit`. Returns false when it would not.
async function raiseCounter(workspaceId: Types.ObjectId, day: string, bytes: number, limit: number, expiresAt?: Date) {
  // A counter that does not exist yet would be created by the update below whatever the size, so check that first.
  if (bytes > limit) return false;
  try {
    await StorageUsage.updateOne(
      // Matches only while there is still room. Otherwise the update tries to create the counter,
      // finds it already exists (unique index) and fails: that failure means "no room".
      { workspaceId, day, bytes: { $lte: limit - bytes } },
      { $inc: { bytes }, ...(expiresAt ? { $setOnInsert: { expiresAt } } : {}) },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

/** Reserves room for `bytes` of new text. Returns null when reserved, or why it was refused (nothing is kept then). */
export async function reserveStorage(workspaceId: Types.ObjectId, isDemo: boolean, bytes: number, now = new Date()): Promise<QuotaRefusal | null> {
  const day = dayKey(now);
  const expiresAt = new Date(now.getTime() + STORAGE_COUNTER_KEEP_DAYS * 24 * 60 * 60 * 1000);
  if (!(await raiseCounter(workspaceId, day, bytes, dailyLimitFor(isDemo), expiresAt))) return "day";
  if (!(await raiseCounter(workspaceId, STORAGE_TOTAL_KEY, bytes, MAX_BYTES_PER_WORKSPACE_TOTAL))) {
    // The day had room but the all-time total did not: give the day's share back.
    await releaseStorage(workspaceId, bytes, now, [day]);
    return "total";
  }
  return null;
}

/** Gives reserved room back, for example when the batch could not be saved after all. */
export async function releaseStorage(workspaceId: Types.ObjectId, bytes: number, now = new Date(), keys = [dayKey(now), STORAGE_TOTAL_KEY]) {
  await StorageUsage.updateMany({ workspaceId, day: { $in: keys } }, { $inc: { bytes: -bytes } });
}

/** Reserves room for `bytes` for a workspace, or answers 429 with a friendly message. Used by everything that saves step text. */
export async function assertStorageRoom(workspaceId: Types.ObjectId, bytes: number, now = new Date()) {
  const workspace = await Workspace.findById(workspaceId).select("isDemo").lean();
  const refusal = await reserveStorage(workspaceId, Boolean(workspace?.isDemo), bytes, now);
  if (refusal === "day") throw new TooManyRequestsError("This workspace has reached its storage limit for today.");
  if (refusal === "total") throw new TooManyRequestsError("This workspace has reached its storage limit.");
}
