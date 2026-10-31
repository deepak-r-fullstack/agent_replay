// Shared constant lists. Kept as `as const` tuples so the same list drives
// TypeScript types, Mongoose enums and zod validation.

// owner: runs the workspace. developer: connects apps and forks runs. viewer: can only look.
export const USER_ROLES = ["owner", "developer", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const WORKSPACE_PLANS = ["free"] as const;
export type WorkspacePlan = (typeof WORKSPACE_PLANS)[number];

// Every app gets its own SDK key. A cap keeps one workspace from filling the free database with apps.
export const MAX_APPS_PER_WORKSPACE = 20;

// SDK keys start with this so people (and secret scanners) can recognise them.
export const API_KEY_PREFIX = "ar_";

// The shared account behind the "Try the demo" button.
export const DEMO_WORKSPACE_SLUG = "demo-acme-support";
export const DEMO_WORKSPACE_NAME = "Acme Support (demo)";
export const DEMO_USER_EMAIL = "demo@agentreplay.test";
// Nobody may sign up with an address on this domain, so no real account can ever look like the demo's.
export const RESERVED_EMAIL_SUFFIX = "@agentreplay.test";
export const DEMO_USER_NAME = "Demo Visitor";
