import { Request, Response } from "express";
import { z } from "zod";
import { DEFAULT_RUNS_PAGE_SIZE, DISPLAY_STATUSES, MAX_FORK_EDITS, MAX_RUNS_PAGE_SIZE, MAX_STEPS_PER_RUN, MAX_STEP_TEXT_BYTES } from "../constants";
import { NotFoundError } from "../helpers/errors";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser } from "../middlewares/auth.middleware";
import { getComparison } from "../services/forks/compare.service";
import { forkRun } from "../services/forks/fork.service";
import { appNamesOf, getRunWithSteps, getStepDetail, listRuns, toRunSummary } from "../services/runs/runs.service";

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

// ---------- forks ----------

const forkEditSchema = z.object({
  prompt: z.string().max(MAX_STEP_TEXT_BYTES).optional(), // AI steps: what the AI is asked
  model: z.string().trim().min(1).max(80).optional(), // AI steps
  output: z.string().max(MAX_STEP_TEXT_BYTES).optional(), // tool, lookup and custom steps: the result to pretend they gave
});

export const forkRunSchema = z.object({
  fromStepIndex: z.number().int().min(0).max(MAX_STEPS_PER_RUN - 1),
  // Keys are step numbers (0, 1, 2 ...).
  edits: z
    .record(z.string().regex(/^\d+$/, "Step numbers must be whole numbers."), forkEditSchema)
    .refine((edits) => Object.keys(edits).length <= MAX_FORK_EDITS, { message: `You can change up to ${MAX_FORK_EDITS} steps in one fork.` })
    .default({}),
});

export async function forkRunHandler(req: Request, res: Response) {
  const user = getRequestUser(res);
  const { fromStepIndex, edits } = res.locals.body as z.infer<typeof forkRunSchema>;
  const fork = await forkRun(user.workspaceId, req.params.id, {
    fromStepIndex,
    edits: Object.fromEntries(Object.entries(edits).map(([index, edit]) => [Number(index), edit])),
  });
  const run = toRunSummary(fork.toObject(), await appNamesOf(user.workspaceId), new Date());
  return successResponseWithData(res, "Fork created. Nothing real was run: tools were simulated.", { run }, 201);
}

export async function getRunComparison(req: Request, res: Response) {
  const user = getRequestUser(res);
  const comparison = await getComparison(user.workspaceId, req.params.id);
  if (!comparison) throw new NotFoundError("That run was not found.");
  return successResponseWithData(res, "Comparison.", comparison);
}
