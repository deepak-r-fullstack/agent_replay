import { Request, Response } from "express";
import { z } from "zod";
import { AGENTGUARD_SYSTEM, EXTERNAL_REF_ID_MAX } from "../constants";
import { NotFoundError } from "../helpers/errors";
import { successResponseWithData } from "../helpers/response";
import { Run } from "../models/run.model";
import { Step } from "../models/step.model";
import { getRequestApp } from "../middlewares/auth.middleware";
import { ingestBatch } from "../services/ingest/ingest.service";
import { IngestBatch, ingestBatchSchema } from "../services/ingest/ingestSchemas";

// Where the SDK sends recorded runs. Called by an app (with its SDK key), not by a signed-in person.

export { ingestBatchSchema };

export async function receiveBatch(_req: Request, res: Response) {
  const app = getRequestApp(res);
  const result = await ingestBatch(app, res.locals.body as IngestBatch);
  return successResponseWithData(res, "Recorded.", result);
}

// ---------- did my recording arrive? ----------

export const recordedRunQuerySchema = z.object({
  // The AgentGuard action the caller expects the run to link to. Optional; without it "linked" is false.
  ref: z.string().trim().min(1).max(EXTERNAL_REF_ID_MAX).optional(),
});

// Lets an app check that one of ITS OWN runs has arrived, so it can tell a person "your recording is ready" instead of
// guessing. Only says whether it exists, how far it got and whether it links to the given AgentGuard action: never
// any text. Another app's run (even one with the same id) is "not found".
export async function getRecordedRun(req: Request, res: Response) {
  const app = getRequestApp(res);
  const externalId = String(req.params.externalId || "").slice(0, 64);
  const { ref } = res.locals.query as z.infer<typeof recordedRunQuerySchema>;
  const run = await Run.findOne({ appId: app._id, externalId }).select("_id status stepCount").lean();
  if (!run) throw new NotFoundError("That recording has not arrived.");
  const linked = ref ? Boolean(await Step.exists({ runId: run._id, "externalRef.system": AGENTGUARD_SYSTEM, "externalRef.id": ref })) : false;
  return successResponseWithData(res, "Recording found.", { externalId, status: run.status, stepCount: run.stepCount, linked });
}
