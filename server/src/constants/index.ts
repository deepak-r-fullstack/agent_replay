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

// ---------- recording runs ----------

export const STEP_TYPES = ["llm", "tool", "retrieval", "custom"] as const;
export type StepType = (typeof STEP_TYPES)[number];

// running -> ok or failed. A finished run is never taken back to "running" by a late message.
export const RUN_STATUSES = ["running", "ok", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// Free-tier safe limits. The SDK follows the same numbers.
export const MAX_STEPS_PER_BATCH = 500;
export const MAX_RUNS_PER_BATCH = 50;
export const MAX_STEPS_PER_RUN = 1000;
export const MAX_STEP_TEXT_BYTES = 32 * 1024; // input and output of one step
export const MAX_STEP_ERROR_BYTES = 4 * 1024;
export const INGEST_BODY_LIMIT = "4mb"; // the rest of the API keeps its small 100kb limit
export const UNTITLED_RUN_NAME = "Untitled run";

// Storage limits per workspace. The free Atlas cluster holds 512 MB in total and is shared with AgentGuard,
// so no single workspace may fill it. Counted in bytes of NEW step text (name + input + output + error).
export const MAX_BYTES_PER_WORKSPACE_PER_DAY = 20 * 1024 * 1024;
export const MAX_BYTES_PER_DEMO_WORKSPACE_PER_DAY = 5 * 1024 * 1024; // the demo is open to anyone, so it gets less
export const MAX_BYTES_PER_WORKSPACE_TOTAL = 100 * 1024 * 1024;
// The counter key that holds a workspace's all-time total (the daily counters use the date, for example "2026-10-31").
export const STORAGE_TOTAL_KEY = "total";
// Daily counters tidy themselves away after this long.
export const STORAGE_COUNTER_KEEP_DAYS = 40;
