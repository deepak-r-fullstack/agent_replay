import { Schema, model, InferSchemaType, Types } from "mongoose";
import { CHECK_TYPES, RESULT_CHANGES, RESULT_OUTCOMES } from "../constants";

// A saved test: "when the AI is asked this, its answer must pass these checks". Saved from a step of a run, so it
// remembers the run it came from. "Run all tests" asks the AI again and records how each answer did.
const checkSchema = new Schema(
  {
    type: { type: String, enum: CHECK_TYPES, required: true },
    // Words for contains / not_contains / equals; a number for max_cost (US dollars) and max_ms (milliseconds).
    value: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const failedCheckSchema = new Schema({ type: { type: String }, value: { type: Schema.Types.Mixed }, message: { type: String } }, { _id: false });

// How the test did the last time all tests were run. Kept here so the Tests screen needs no extra lookup.
const lastResultSchema = new Schema(
  {
    suiteRunId: { type: Schema.Types.ObjectId },
    outcome: { type: String, enum: RESULT_OUTCOMES },
    change: { type: String, enum: RESULT_CHANGES },
    output: { type: String, default: "" },
    failedChecks: { type: [failedCheckSchema], default: [] },
    error: { type: String, default: "" },
    costUsd: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    model: { type: String, default: "" },
    note: { type: String, default: "" },
    ranAt: { type: Date },
  },
  { _id: false }
);

const testCaseSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    name: { type: String, required: true, trim: true },
    sourceRunId: { type: Schema.Types.ObjectId, ref: "Run", required: true },
    sourceStepIndex: { type: Number, required: true },
    input: { type: String, required: true }, // what the AI is asked, as saved with the step
    model: { type: String, default: "" }, // the model the step used
    checks: { type: [checkSchema], default: [] },
    lastResult: { type: lastResultSchema, default: undefined },
    // The last time the checks were really made: passed or failed (not "could not run"). A new result is compared with this.
    lastCheckedOutcome: { type: String, enum: ["passed", "failed"] },
  },
  { timestamps: true }
);

testCaseSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export type TestCaseDoc = InferSchemaType<typeof testCaseSchema> & { _id: Types.ObjectId };
export const TestCase = model("TestCase", testCaseSchema);
