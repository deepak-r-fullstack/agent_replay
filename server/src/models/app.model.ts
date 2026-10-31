import { Schema, model, InferSchemaType, Types } from "mongoose";

// An app (or AI feature) that sends runs to AgentReplay through the SDK. Apps authenticate
// with an SDK key; only its SHA-256 hash is stored, so a database leak does not leak keys.
const appSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    apiKeyHash: { type: String, required: true, unique: true, select: false },
    apiKeyPreview: { type: String, required: true }, // e.g. "ar_3f9c…" so people can tell keys apart
    // Revoked = the key stops working at once. The app and its old runs stay visible.
    active: { type: Boolean, default: true },
    // Made by the demo seed. Its key cannot be revoked or rotated, and it does not use up a visitor's app slots.
    seeded: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export type AppDoc = InferSchemaType<typeof appSchema> & { _id: Types.ObjectId };
export const App = model("App", appSchema);
