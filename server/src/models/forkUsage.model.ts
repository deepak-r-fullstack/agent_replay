import { Schema, model, InferSchemaType, Types } from "mongoose";

// How many forks a workspace has started today (UTC). One small counter per workspace per day, raised with a single
// atomic update (see utils/atomicCounter.ts), the same way storage is counted.
const forkUsageSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  day: { type: String, required: true }, // "2026-10-31"
  count: { type: Number, default: 0 },
  expiresAt: { type: Date },
});

forkUsageSchema.index({ workspaceId: 1, day: 1 }, { unique: true });
// MongoDB removes old counters by itself (a TTL index).
forkUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type ForkUsageDoc = InferSchemaType<typeof forkUsageSchema> & { _id: Types.ObjectId };
export const ForkUsage = model("ForkUsage", forkUsageSchema);
