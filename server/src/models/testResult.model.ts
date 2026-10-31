import { Schema, model, InferSchemaType, Types } from "mongoose";
import { RESULT_CHANGES, RESULT_OUTCOMES, TEST_RESULT_KEEP_DAYS } from "../constants";

// One test's result in one "Run all tests" (a suite run). Kept for a while so the change over time can be looked at.
const testResultSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
  testCaseId: { type: Schema.Types.ObjectId, ref: "TestCase", required: true },
  suiteRunId: { type: Schema.Types.ObjectId, required: true },
  outcome: { type: String, enum: RESULT_OUTCOMES, required: true },
  change: { type: String, enum: RESULT_CHANGES, required: true },
  passed: { type: Boolean, required: true },
  output: { type: String, default: "" }, // cut to 4 KB and with secrets hidden
  failedChecks: { type: [new Schema({ type: String, value: Schema.Types.Mixed, message: String }, { _id: false })], default: [] },
  error: { type: String, default: "" },
  costUsd: { type: Number, default: 0 },
  tokens: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },
  model: { type: String, default: "" },
  note: { type: String, default: "" },
  ranAt: { type: Date, default: Date.now },
});

testResultSchema.index({ suiteRunId: 1 });
testResultSchema.index({ testCaseId: 1, ranAt: -1 });
testResultSchema.index({ workspaceId: 1, ranAt: -1 });
// MongoDB removes old results by itself (a TTL index on the time they were made).
testResultSchema.index({ ranAt: 1 }, { expireAfterSeconds: TEST_RESULT_KEEP_DAYS * 24 * 60 * 60 });

export type TestResultDoc = InferSchemaType<typeof testResultSchema> & { _id: Types.ObjectId };
export const TestResult = model("TestResult", testResultSchema);
