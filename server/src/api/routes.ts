import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env, isTest } from "../config/env";
import { asyncHandler } from "../helpers/asyncHandler";
import { authenticateApp, authenticateUser, authorizeRoles } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validateRequest.middleware";
import { NotFoundError } from "../helpers/errors";

import * as authController from "../controllers/auth.controller";
import * as appsController from "../controllers/apps.controller";
import * as ingestController from "../controllers/ingest.controller";
import * as runsController from "../controllers/runs.controller";

const router = Router();

// Rate limits: slow down password guessing and account-creation floods.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: isTest ? 1000 : 10, standardHeaders: true, legacyHeaders: false });

// Ingest: first a loose limit per address (stops floods of bad keys), then a limit per app once its key is known.
// The SDK sends about one request every 2 seconds, so the per-app limit leaves plenty of room.
const ingestAddressLimiter = rateLimit({ windowMs: 60 * 1000, limit: isTest ? 100000 : 300, standardHeaders: true, legacyHeaders: false });
const ingestAppLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isTest ? 100000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.app?._id),
  message: { success: false, message: "This app is sending too fast. Please slow down and try again in a minute." },
});

// Forks ask the AI model, which can cost money, so each workspace may only start a few per minute.
const forkLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: isTest ? 100000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => String(res.locals.user?.workspaceId),
  message: { success: false, message: "You are starting forks very quickly. Please wait a minute and try again." },
});

const demoOnly = (_req: unknown, _res: unknown, next: (err?: unknown) => void) =>
  env.DEMO_MODE ? next() : next(new NotFoundError("The demo is turned off."));

router.get("/health", (_req, res) => {
  res.json({ success: true, message: "AgentReplay is running." });
});

// ---------- people: sign up and sign in ----------
router.post("/auth/signup", signupLimiter, validateRequest(authController.signupSchema), asyncHandler(authController.signupUser));
router.post("/auth/login", loginLimiter, validateRequest(authController.loginSchema), asyncHandler(authController.loginUser));
router.post("/auth/demo", demoOnly, loginLimiter, asyncHandler(authController.loginDemo));
router.get("/auth/me", authenticateUser, asyncHandler(authController.getCurrentUser));

// ---------- people: apps and SDK keys (viewers can look, owners and developers can change) ----------
router.get("/apps", authenticateUser, asyncHandler(appsController.getApps));
router.post(
  "/apps",
  authenticateUser,
  authorizeRoles("owner", "developer"),
  validateRequest(appsController.createAppSchema),
  asyncHandler(appsController.addApp)
);
router.post("/apps/:id/rotate-key", authenticateUser, authorizeRoles("owner", "developer"), asyncHandler(appsController.rotateKey));
router.post("/apps/:id/revoke-key", authenticateUser, authorizeRoles("owner", "developer"), asyncHandler(appsController.revokeKey));

// ---------- people: runs and replay (everyone in the workspace may look) ----------
router.get("/runs", authenticateUser, validateRequest(runsController.listRunsQuerySchema, "query"), asyncHandler(runsController.getRuns));
router.get("/runs/:id", authenticateUser, asyncHandler(runsController.getRunDetail));
router.get("/runs/:id/steps/:index", authenticateUser, asyncHandler(runsController.getStep));
router.get("/runs/:id/compare", authenticateUser, asyncHandler(runsController.getRunComparison));
// Viewers can look at runs but cannot start forks.
router.post(
  "/runs/:id/fork",
  authenticateUser,
  authorizeRoles("owner", "developer"),
  forkLimiter,
  validateRequest(runsController.forkRunSchema),
  asyncHandler(runsController.forkRunHandler)
);

// ---------- apps: the SDK sends recorded runs here ----------
router.post(
  "/ingest",
  ingestAddressLimiter,
  authenticateApp,
  ingestAppLimiter,
  validateRequest(ingestController.ingestBatchSchema),
  asyncHandler(ingestController.receiveBatch)
);

export default router;
