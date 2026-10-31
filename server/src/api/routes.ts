import { Router } from "express";
import rateLimit from "express-rate-limit";
import { env, isTest } from "../config/env";
import { asyncHandler } from "../helpers/asyncHandler";
import { authenticateUser, authorizeRoles } from "../middlewares/auth.middleware";
import { validateRequest } from "../middlewares/validateRequest.middleware";
import { NotFoundError } from "../helpers/errors";

import * as authController from "../controllers/auth.controller";
import * as appsController from "../controllers/apps.controller";

const router = Router();

// Rate limits: slow down password guessing and account-creation floods.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: isTest ? 1000 : 20, standardHeaders: true, legacyHeaders: false });
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: isTest ? 1000 : 10, standardHeaders: true, legacyHeaders: false });

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

export default router;
