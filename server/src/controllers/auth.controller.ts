import { Request, Response } from "express";
import { z } from "zod";
import { successResponseWithData } from "../helpers/response";
import { demoLogin, login, signup } from "../services/auth/auth.service";
import { resetDemoIfDue } from "../services/demo/demoSeed.service";
import { getRequestUser } from "../middlewares/auth.middleware";
import { Workspace } from "../models/workspace.model";

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const signupSchema = z.object({
  name: z.string().trim().min(1, "Please enter your name.").max(80),
  workspaceName: z.string().trim().min(1, "Please enter a name for your team.").max(80),
  email: z.string().trim().email(),
  // Long enough to be safe, short enough that nobody gives up. bcrypt only reads the first 72 bytes.
  password: z.string().min(8, "Use at least 8 characters.").max(72),
});

export async function loginUser(_req: Request, res: Response) {
  const { email, password } = res.locals.body as z.infer<typeof loginSchema>;
  const session = await login(email, password);
  return successResponseWithData(res, "Signed in.", session);
}

export async function signupUser(_req: Request, res: Response) {
  const session = await signup(res.locals.body as z.infer<typeof signupSchema>);
  return successResponseWithData(res, "Your account is ready.", session, 201);
}

export async function loginDemo(_req: Request, res: Response) {
  // The shared demo starts again from its story when it is due (once an hour), before the visitor arrives.
  await resetDemoIfDue();
  const session = await demoLogin();
  return successResponseWithData(res, "Signed in to the demo.", session);
}

export async function getCurrentUser(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const workspace = await Workspace.findById(user.workspaceId).lean();
  return successResponseWithData(res, "Current user.", {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    workspaceId: String(user.workspaceId),
    workspaceName: workspace?.name || "",
    isDemo: Boolean(workspace?.isDemo),
  });
}
