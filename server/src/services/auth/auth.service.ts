import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { env } from "../../config/env";
import { User, UserDoc } from "../../models/user.model";
import { App, AppDoc } from "../../models/app.model";
import { Workspace } from "../../models/workspace.model";
import {
  API_KEY_PREFIX,
  DEMO_USER_EMAIL,
  DEMO_USER_NAME,
  DEMO_WORKSPACE_NAME,
  DEMO_WORKSPACE_SLUG,
  UserRole,
} from "../../constants";
import { ConflictError, UnauthorizedError } from "../../helpers/errors";

export interface AuthTokenPayload {
  sub: string; // user id
  workspaceId: string;
  role: UserRole;
  name: string;
  email: string;
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export function signToken(user: Pick<UserDoc, "_id" | "workspaceId" | "role" | "name" | "email">) {
  const payload: AuthTokenPayload = {
    sub: String(user._id),
    workspaceId: String(user.workspaceId),
    role: user.role,
    name: user.name,
    email: user.email,
  };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] });
}

export function verifyToken(token: string): AuthTokenPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
  } catch {
    throw new UnauthorizedError("Your session has ended. Please sign in again.");
  }
}

// Users created before the "active" field existed have no value, and they are active.
export function isUserActive(user: { active?: boolean | null }) {
  return user.active !== false;
}

// What the screens need to know about a signed-in person. Never includes the password hash.
function buildSession(user: Pick<UserDoc, "_id" | "workspaceId" | "role" | "name" | "email">, workspaceName: string) {
  return {
    token: signToken(user),
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      workspaceId: String(user.workspaceId),
      workspaceName,
    },
  };
}

export async function login(email: string, password: string) {
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+passwordHash");
  // Same message for "no such user" and "wrong password", so emails cannot be guessed.
  const passwordOk = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !passwordOk) throw new UnauthorizedError("Email or password is not correct.");
  // Only said after the password is right, so this message cannot be used to find out who has an account.
  if (!isUserActive(user)) throw new UnauthorizedError("This account has been turned off. Please ask the owner of your workspace.");

  const workspace = await Workspace.findById(user.workspaceId).lean();
  return buildSession(user, workspace?.name || "");
}

// "My Team!" -> "my-team-3f9c1a". The random tail keeps two teams with the same name apart.
function makeWorkspaceSlug(name: string) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

// Self-serve sign-up: a new person gets a brand-new workspace and owns it.
export async function signup(input: { name: string; email: string; password: string; workspaceName: string }) {
  const email = input.email.toLowerCase().trim();
  if (await User.exists({ email })) throw new ConflictError("There is already an account with this email. Try signing in instead.");

  const workspace = await Workspace.create({ name: input.workspaceName, slug: makeWorkspaceSlug(input.workspaceName) });
  try {
    const user = await User.create({
      workspaceId: workspace._id,
      name: input.name,
      email,
      passwordHash: await hashPassword(input.password),
      role: "owner",
    });
    return buildSession(user, workspace.name);
  } catch (err) {
    // Two sign-ups with the same email at the same moment: the unique index stops the second one.
    // Remove the empty workspace so nothing is left behind.
    await Workspace.deleteOne({ _id: workspace._id });
    if ((err as { code?: number }).code === 11000) {
      throw new ConflictError("There is already an account with this email. Try signing in instead.");
    }
    throw err;
  }
}

// The "Try the demo" button. One shared demo workspace and visitor, created on first use.
// The visitor is a developer, so they can try everything except managing the workspace.
export async function demoLogin() {
  const workspace = await Workspace.findOneAndUpdate(
    { slug: DEMO_WORKSPACE_SLUG },
    { $setOnInsert: { name: DEMO_WORKSPACE_NAME, slug: DEMO_WORKSPACE_SLUG, isDemo: true } },
    { upsert: true, new: true }
  ).lean();

  let user = await User.findOne({ email: DEMO_USER_EMAIL });
  if (!user) {
    try {
      user = await User.create({
        workspaceId: workspace!._id,
        name: DEMO_USER_NAME,
        email: DEMO_USER_EMAIL,
        // Nobody signs in with this password: the demo button signs in without one.
        passwordHash: await hashPassword(crypto.randomBytes(24).toString("hex")),
        role: "developer",
      });
    } catch (err) {
      // Two visitors pressed the button at once; the other one created the user first.
      if ((err as { code?: number }).code !== 11000) throw err;
      user = await User.findOne({ email: DEMO_USER_EMAIL });
    }
  }
  return buildSession(user!, workspace!.name);
}

// ---------- SDK keys ----------

export function hashApiKey(apiKey: string) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export function generateApiKey() {
  const apiKey = `${API_KEY_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
  return { apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyPreview: `${apiKey.slice(0, 8)}…` };
}

// Used by the SDK ingest endpoint (milestone 2). Revoked apps return null.
export async function findAppByApiKey(apiKey: string): Promise<AppDoc | null> {
  if (!apiKey.startsWith(API_KEY_PREFIX)) return null;
  return App.findOne({ apiKeyHash: hashApiKey(apiKey), active: true }).lean<AppDoc>();
}

export async function rotateAppKey(workspaceId: Types.ObjectId, appId: string) {
  const { apiKey, apiKeyHash, apiKeyPreview } = generateApiKey();
  const app = await App.findOneAndUpdate(
    { _id: appId, workspaceId },
    // Rotating also switches a revoked app back on: a new key is a fresh start.
    { $set: { apiKeyHash, apiKeyPreview, active: true } },
    { new: true }
  ).lean<AppDoc>();
  return app ? { app, apiKey } : null;
}
