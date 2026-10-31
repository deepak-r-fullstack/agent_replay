import { Schema, model, InferSchemaType, Types } from "mongoose";
import { STEP_TYPES } from "../constants";

// One step of a run: an AI call, a tool call, a lookup. Steps are written once and never change.
const stepSchema = new Schema({
  runId: { type: Schema.Types.ObjectId, ref: "Run", required: true },
  index: { type: Number, required: true }, // 0, 1, 2 ... the order shown on the replay timeline
  type: { type: String, enum: STEP_TYPES, required: true },
  name: { type: String, default: "" },
  input: { type: String, default: "" }, // text, capped at 32 KB and with secrets hidden
  output: { type: String, default: "" },
  model: { type: String, default: "" },
  tokens: { type: Number, default: 0 },
  costUsd: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },
  error: { type: String, default: "" }, // empty = the step worked
  startedAt: { type: Date, default: Date.now },
});

// The replay timeline, and the guard that makes a repeated batch change nothing.
stepSchema.index({ runId: 1, index: 1 }, { unique: true });

export type StepDoc = InferSchemaType<typeof stepSchema> & { _id: Types.ObjectId };
export const Step = model("Step", stepSchema);
