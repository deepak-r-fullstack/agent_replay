import { Schema, model, InferSchemaType, Types } from "mongoose";

// How many AI calls a workspace's test runs have made today (UTC). One small counter per workspace per day, raised with
// a single atomic update (see utils/atomicCounter.ts), the same way forks and storage are counted.
const testRunUsageSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  day: { type: String, required: true }, // "2026-10-31"
  count: { type: Number, default: 0 },
  expiresAt: { type: Date },
});

testRunUsageSchema.index({ workspaceId: 1, day: 1 }, { unique: true });
testRunUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type TestRunUsageDoc = InferSchemaType<typeof testRunUsageSchema> & { _id: Types.ObjectId };
export const TestRunUsage = model("TestRunUsage", testRunUsageSchema);
