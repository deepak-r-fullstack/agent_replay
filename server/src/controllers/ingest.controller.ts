import { Request, Response } from "express";
import { successResponseWithData } from "../helpers/response";
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
