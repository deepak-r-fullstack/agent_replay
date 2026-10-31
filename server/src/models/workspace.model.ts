import { Schema, model, InferSchemaType } from "mongoose";
import { WORKSPACE_PLANS } from "../constants";

// A workspace is one customer team (a "tenant"). Every other document carries its
// workspaceId, and every query filters by it, so teams never see each other's runs.
const workspaceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    plan: { type: String, enum: WORKSPACE_PLANS, default: "free" },
    // Demo workspaces get their runs cleaned up automatically after 30 days (milestone 6).
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export type WorkspaceDoc = InferSchemaType<typeof workspaceSchema>;
export const Workspace = model("Workspace", workspaceSchema);
