import { Request, Response } from "express";
import { z } from "zod";
import { successResponse, successResponseWithData } from "../helpers/response";
import { getRequestUser } from "../middlewares/auth.middleware";
import { Workspace } from "../models/workspace.model";
import { runSuite } from "../services/tests/suite.service";
import { createTestSchema, runSuiteSchema, updateTestSchema } from "../services/tests/testSchemas";
import { createTest, deleteTest, listTests, updateTest } from "../services/tests/tests.service";

// Screen data for "Tests". Everyone in the workspace may look; owners and developers may save, change, delete and run.

export { createTestSchema, runSuiteSchema, updateTestSchema };

const isDemoWorkspace = async (res: Response) => Boolean((await Workspace.findById(getRequestUser(res).workspaceId).select("isDemo").lean())?.isDemo);

export async function getTests(_req: Request, res: Response) {
  const user = getRequestUser(res);
  return successResponseWithData(res, "Tests.", await listTests(user.workspaceId, await isDemoWorkspace(res)));
}

export async function addTest(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const test = await createTest(user.workspaceId, res.locals.body as z.infer<typeof createTestSchema>);
  return successResponseWithData(res, "Saved as a test.", { test }, 201);
}

export async function editTest(req: Request, res: Response) {
  const user = getRequestUser(res);
  const test = await updateTest(user.workspaceId, req.params.id, res.locals.body as z.infer<typeof updateTestSchema>);
  return successResponseWithData(res, "Test updated.", { test });
}

export async function removeTest(req: Request, res: Response) {
  const user = getRequestUser(res);
  await deleteTest(user.workspaceId, req.params.id);
  return successResponse(res, "Test deleted.");
}

export async function runAllTests(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const result = await runSuite(user.workspaceId, res.locals.body as z.infer<typeof runSuiteSchema>);
  return successResponseWithData(res, "Tests finished.", result);
}
