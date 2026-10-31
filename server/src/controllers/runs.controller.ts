import { Request, Response } from "express";
import { z } from "zod";
import { DEFAULT_RUNS_PAGE_SIZE, DISPLAY_STATUSES, MAX_RUNS_PAGE_SIZE } from "../constants";
import { NotFoundError } from "../helpers/errors";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser } from "../middlewares/auth.middleware";
import { getRunWithSteps, getStepDetail, listRuns } from "../services/runs/runs.service";

// Screen data for "Runs" and "Run replay". Everyone in the workspace may look, including viewers.

// The website leaves unused filters out, but an empty value is treated the same way.
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates look like 2026-10-31.");

export const listRunsQuerySchema = z
  .object({
    status: optional(z.enum(DISPLAY_STATUSES)),
    appId: optional(z.string().regex(/^[a-f0-9]{24}$/i, "That app was not found.")),
    q: optional(z.string().trim().max(80)),
    from: optional(dateOnly),
    to: optional(dateOnly),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_RUNS_PAGE_SIZE).default(DEFAULT_RUNS_PAGE_SIZE),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, { message: "The start date must not be after the end date." });

export async function getRuns(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const { page, pageSize, ...filters } = res.locals.query as z.infer<typeof listRunsQuerySchema>;
  return successResponseWithData(res, "Runs.", await listRuns(user.workspaceId, filters, page, pageSize));
}

export async function getRunDetail(req: Request, res: Response) {
  const user = getRequestUser(res);
  const detail = await getRunWithSteps(user.workspaceId, req.params.id);
  if (!detail) throw new NotFoundError("That run was not found.");
  return successResponseWithData(res, "Run.", detail);
}

export async function getStep(req: Request, res: Response) {
  const user = getRequestUser(res);
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) throw new NotFoundError("That step was not found.");
  const step = await getStepDetail(user.workspaceId, req.params.id, index);
  if (!step) throw new NotFoundError("That step was not found.");
  return successResponseWithData(res, "Step.", step);
}
