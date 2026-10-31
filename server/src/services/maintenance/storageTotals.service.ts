import { Types } from "mongoose";
import { MAX_TEST_OUTPUT_BYTES, RUN_STORAGE_BYTES, STORAGE_TOTAL_KEY } from "../../constants";
import { Run } from "../../models/run.model";
import { Step } from "../../models/step.model";
import { StorageUsage } from "../../models/storageUsage.model";
import { TestResult } from "../../models/testResult.model";

// Works out how much a workspace really stores, from its data, the same way storage is counted when it is saved:
// the text of every step, 1 KB for every run, and 4 KB for every test result that was asked (a skipped test gave its share back).
export async function measureWorkspaceStorage(workspaceId: Types.ObjectId | string) {
  const id = new Types.ObjectId(String(workspaceId));
  const [runs] = await Run.aggregate<{ runs: number; stepBytes: number }>([
    { $match: { workspaceId: id } },
    {
      $lookup: {
        from: Step.collection.name,
        let: { runId: "$_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$runId", "$$runId"] } } },
          { $group: { _id: null, bytes: { $sum: { $add: [{ $strLenBytes: "$name" }, { $strLenBytes: "$input" }, { $strLenBytes: "$output" }, { $strLenBytes: "$error" }] } } } },
        ],
        as: "stored",
      },
    },
    { $group: { _id: null, runs: { $sum: 1 }, stepBytes: { $sum: { $ifNull: [{ $arrayElemAt: ["$stored.bytes", 0] }, 0] } } } },
  ]);
  const results = await TestResult.countDocuments({ workspaceId: id, outcome: { $ne: "skipped" } });
  return (runs?.stepBytes ?? 0) + (runs?.runs ?? 0) * RUN_STORAGE_BYTES + results * MAX_TEST_OUTPUT_BYTES;
}

// Puts a workspace's all-time total right, whatever it said before. Returns the real number.
export async function syncWorkspaceStorage(workspaceId: Types.ObjectId | string) {
  const bytes = await measureWorkspaceStorage(workspaceId);
  await StorageUsage.updateOne({ workspaceId, day: STORAGE_TOTAL_KEY }, { $set: { bytes } }, { upsert: true });
  return bytes;
}
