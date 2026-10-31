import { Types } from "mongoose";
import {
  MAX_BYTES_GLOBAL,
  MAX_BYTES_PER_DEMO_WORKSPACE_PER_DAY,
  MAX_BYTES_PER_WORKSPACE_PER_DAY,
  MAX_BYTES_PER_WORKSPACE_TOTAL,
  STORAGE_COUNTER_KEEP_DAYS,
  STORAGE_GLOBAL_KEY,
  STORAGE_GLOBAL_WORKSPACE_ID,
  STORAGE_TOTAL_KEY,
} from "../../constants";
import { TooManyRequestsError } from "../../helpers/errors";
import { StorageUsage } from "../../models/storageUsage.model";
import { Workspace } from "../../models/workspace.model";
import { raiseWithinLimit } from "../../utils/atomicCounter";

// Keeps one workspace from filling the shared free database. Each check is one small update on a counter
// document (no scan of steps). The counter is only raised if the new total stays within the limit, and that
// check and the raise happen in the same atomic step, so many batches at once cannot slip past the limit.

export type QuotaRefusal = "day" | "total" | "global";

const GLOBAL_WORKSPACE_ID = new Types.ObjectId(STORAGE_GLOBAL_WORKSPACE_ID);

export function dayKey(now: Date) {
  return now.toISOString().slice(0, 10); // the UTC date, "2026-10-31"
}

export function dailyLimitFor(isDemo: boolean) {
  return isDemo ? MAX_BYTES_PER_DEMO_WORKSPACE_PER_DAY : MAX_BYTES_PER_WORKSPACE_PER_DAY;
}

// Adds `bytes` to one counter if the result stays within `limit`. Returns false when it would not.
const raiseCounter = (workspaceId: Types.ObjectId, day: string, bytes: number, limit: number, expiresAt?: Date) =>
  raiseWithinLimit(StorageUsage, { workspaceId, day }, "bytes", bytes, limit, expiresAt);

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
  if (!(await raiseCounter(GLOBAL_WORKSPACE_ID, STORAGE_GLOBAL_KEY, bytes, MAX_BYTES_GLOBAL))) {
    // The whole service is full: give back what this workspace was just given.
    await releaseStorage(workspaceId, bytes, now, [day, STORAGE_TOTAL_KEY], false);
    return "global";
  }
  return null;
}

/**
 * Gives reserved room back, for example when the batch could not be saved after all.
 * The all-time total is also part of the global one, so lowering it lowers that too (unless `alsoGlobal` is false).
 */
export async function releaseStorage(workspaceId: Types.ObjectId, bytes: number, now = new Date(), keys = [dayKey(now), STORAGE_TOTAL_KEY], alsoGlobal = true) {
  await StorageUsage.updateMany({ workspaceId, day: { $in: keys } }, { $inc: { bytes: -bytes } });
  if (alsoGlobal && keys.includes(STORAGE_TOTAL_KEY)) await changeGlobalStorage(-bytes);
}

// Moves the one global total up or down. It never goes below zero.
export async function changeGlobalStorage(change: number) {
  if (change === 0) return;
  await StorageUsage.updateOne(
    { workspaceId: GLOBAL_WORKSPACE_ID, day: STORAGE_GLOBAL_KEY },
    [{ $set: { bytes: { $max: [0, { $add: [{ $ifNull: ["$bytes", 0] }, change] }] } } }],
    { upsert: true }
  );
}

// Brings the all-time total (and the global one) down after data was deleted. Neither goes below zero.
export async function lowerStorage(workspaceId: Types.ObjectId, bytes: number) {
  if (bytes <= 0) return;
  await StorageUsage.updateOne({ workspaceId, day: STORAGE_TOTAL_KEY }, [{ $set: { bytes: { $max: [0, { $subtract: ["$bytes", bytes] }] } } }]);
  await changeGlobalStorage(-bytes);
}

/** Reserves room for `bytes` for a workspace, or answers 429 with a friendly message. Used by everything that saves step text. */
export async function assertStorageRoom(workspaceId: Types.ObjectId, bytes: number, now = new Date()) {
  const workspace = await Workspace.findById(workspaceId).select("isDemo").lean();
  const refusal = await reserveStorage(workspaceId, Boolean(workspace?.isDemo), bytes, now);
  if (refusal === "day") throw new TooManyRequestsError("This workspace has reached its storage limit for today.");
  if (refusal === "total") throw new TooManyRequestsError("This workspace has reached its storage limit.");
  if (refusal === "global") throw new TooManyRequestsError("AgentReplay is full for now, so nothing new can be saved. Please try again later.");
}
