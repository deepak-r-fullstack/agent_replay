import { Schema, model, InferSchemaType, Types } from "mongoose";

// How many bytes of step text a workspace has stored. One small counter per workspace per day (UTC),
// plus one all-time counter, so the storage check is a single update, never a scan of all steps.
const storageUsageSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  day: { type: String, required: true }, // "2026-10-31", or "total" for the all-time counter
  bytes: { type: Number, default: 0 },
  // Only daily counters have this; the all-time counter lives as long as the workspace.
  expiresAt: { type: Date },
});

storageUsageSchema.index({ workspaceId: 1, day: 1 }, { unique: true });
// MongoDB removes old daily counters by itself (a TTL index).
storageUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type StorageUsageDoc = InferSchemaType<typeof storageUsageSchema> & { _id: Types.ObjectId };
export const StorageUsage = model("StorageUsage", storageUsageSchema);
