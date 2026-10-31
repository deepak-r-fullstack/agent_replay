import { Request, Response } from "express";
import { z } from "zod";
import { MAX_APPS_PER_WORKSPACE } from "../constants";
import { BadRequestError, ForbiddenError, NotFoundError } from "../helpers/errors";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser } from "../middlewares/auth.middleware";
import { App, AppDoc } from "../models/app.model";
import { generateApiKey, rotateAppKey } from "../services/auth/auth.service";

// Screen data for "Apps and keys": the apps that send runs to AgentReplay.

export const createAppSchema = z.object({
  name: z.string().trim().min(1, "Please give the app a name.").max(60),
});

// Never includes the key hash. The full key is only ever returned by create and rotate.
function toAppSummary(app: AppDoc) {
  return {
    id: String(app._id),
    name: app.name,
    apiKeyPreview: app.apiKeyPreview,
    active: app.active,
    seeded: Boolean(app.seeded),
    createdAt: app.createdAt,
  };
}

export async function getApps(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const apps = await App.find({ workspaceId: user.workspaceId }).sort({ createdAt: -1 }).lean<AppDoc[]>();
  return successResponseWithData(res, "Apps.", apps.map(toAppSummary));
}

// Shows the new key ONCE. Only its hash is stored, so it cannot be shown again later.
export async function addApp(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const { name } = res.locals.body as z.infer<typeof createAppSchema>;

  // Apps made by the demo seed are not counted, so they never take a visitor's slot.
  if ((await App.countDocuments({ workspaceId: user.workspaceId, seeded: { $ne: true } })) >= MAX_APPS_PER_WORKSPACE) {
    throw new BadRequestError(`You can connect up to ${MAX_APPS_PER_WORKSPACE} apps. Remove one you no longer use first.`);
  }

  const { apiKey, apiKeyHash, apiKeyPreview } = generateApiKey();
  const app = await App.create({ workspaceId: user.workspaceId, name, apiKeyHash, apiKeyPreview });
  return successResponseWithData(
    res,
    "App created. Copy the key now — it will not be shown again.",
    { ...toAppSummary(app.toObject() as AppDoc), apiKey },
    201
  );
}

// The demo's own app must keep working for every visitor, so nobody can switch its key off or replace it.
async function refuseIfSeeded(workspaceId: AppDoc["workspaceId"], appId: string) {
  const app = await App.findOne({ _id: appId, workspaceId }).select("seeded").lean<Pick<AppDoc, "seeded">>().catch(() => null);
  if (app?.seeded) throw new ForbiddenError("This app is part of the demo, so its key can't be changed.");
}

export async function rotateKey(req: Request, res: Response) {
  const user = getRequestUser(res);
  await refuseIfSeeded(user.workspaceId, req.params.id);
  const rotated = await rotateAppKey(user.workspaceId, req.params.id);
  if (!rotated) throw new NotFoundError("That app was not found.");
  return successResponseWithData(res, "New key created. Copy it now — it will not be shown again.", {
    ...toAppSummary(rotated.app),
    apiKey: rotated.apiKey,
  });
}

// Revoking switches the key off at once. The app and its recorded runs stay.
export async function revokeKey(req: Request, res: Response) {
  const user = getRequestUser(res);
  await refuseIfSeeded(user.workspaceId, req.params.id);
  const app = await App.findOneAndUpdate({ _id: req.params.id, workspaceId: user.workspaceId }, { $set: { active: false } }, { new: true }).lean<AppDoc>();
  if (!app) throw new NotFoundError("That app was not found.");
  return successResponseWithData(res, "Key revoked. This app can no longer send runs.", toAppSummary(app));
}
