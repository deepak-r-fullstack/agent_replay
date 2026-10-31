import { Schema, model, InferSchemaType, Types } from "mongoose";
import { RUN_STATUSES, UNTITLED_RUN_NAME } from "../constants";

// One run of an AI feature. A fork is just another run that points back to its parent run
// and the step it was forked from, so the runs list, replay and forks all share one model.
const runSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    appId: { type: Schema.Types.ObjectId, ref: "App", required: true },
    // The id the SDK gave the run before the server knew it. Lets a repeated or late batch find the same run.
    externalId: { type: String },
    name: { type: String, default: UNTITLED_RUN_NAME, trim: true },
    status: { type: String, enum: RUN_STATUSES, default: "running" },
    userRef: { type: String, default: "" }, // who the run was for
    model: { type: String, default: "" }, // the first AI model used
    totalTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    // The time the SDK measured for the whole run. Until it arrives, the step times are added up instead.
    reportedDurationMs: { type: Number, default: 0 },
    stepCount: { type: Number, default: 0 },
    tags: { type: [String], default: [] },
    parentRunId: { type: Schema.Types.ObjectId, ref: "Run", default: null },
    forkedFromStepId: { type: Schema.Types.ObjectId, ref: "Step", default: null },
    startedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// The runs list and its filters.
runSchema.index({ workspaceId: 1, startedAt: -1 });
runSchema.index({ workspaceId: 1, status: 1 });
// The fork tree.
runSchema.index({ parentRunId: 1 });
// One SDK run id per app. Runs the server makes itself (forks) have no externalId, so they are left out.
runSchema.index({ appId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });

export type RunDoc = InferSchemaType<typeof runSchema> & { _id: Types.ObjectId };
export const Run = model("Run", runSchema);
