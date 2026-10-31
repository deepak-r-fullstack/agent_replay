import { Schema, model, InferSchemaType, Types } from "mongoose";

// When each housekeeping job last ran. A job is "claimed" with one atomic update (see claimJob.ts),
// so two servers waking up at the same moment cannot both run it.
const maintenanceLogSchema = new Schema({
  name: { type: String, required: true, unique: true },
  lastRunAt: { type: Date, required: true },
});

export type MaintenanceLogDoc = InferSchemaType<typeof maintenanceLogSchema> & { _id: Types.ObjectId };
export const MaintenanceLog = model("MaintenanceLog", maintenanceLogSchema);
