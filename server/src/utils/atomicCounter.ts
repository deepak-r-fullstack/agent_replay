import { Model } from "mongoose";
import { isDuplicateKeyError } from "./mongoErrors";

// Raises one counter document (for example "bytes stored today" or "forks started today") by `amount`, but only if the
// new total stays within `limit`. The check and the raise are ONE atomic update, so many requests at once cannot slip
// past the limit, and it costs a single small write: no scan of anything. Returns false when there is no room.
// `key` finds the counter (workspace and day); `field` is the number that is raised.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function raiseWithinLimit(model: Model<any>, key: Record<string, unknown>, field: string, amount: number, limit: number, expiresAt?: Date) {
  // A counter that does not exist yet would be created by the update below whatever the size, so check that first.
  if (amount > limit) return false;
  try {
    await model.updateOne(
      // Matches only while there is still room. Otherwise the update tries to create the counter,
      // finds it already exists (unique index) and fails: that failure means "no room".
      { ...key, [field]: { $lte: limit - amount } },
      { $inc: { [field]: amount }, ...(expiresAt ? { $setOnInsert: { expiresAt } } : {}) },
      { upsert: true }
    );
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}
