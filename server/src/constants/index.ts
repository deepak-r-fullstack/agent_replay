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
// Every new run (recorded or forked) counts this much too, so runs with no steps cannot get around the limits.
export const RUN_STORAGE_BYTES = 1024;
// One limit across ALL workspaces together. New workspaces are free to create and the Atlas cluster (512 MB) is shared with AgentGuard.
export const MAX_BYTES_GLOBAL = 250 * 1024 * 1024;
// The counter key for that limit. It lives under a fixed "no workspace" id (all zeros), so it never mixes with a real workspace.
export const STORAGE_GLOBAL_KEY = "global";
export const STORAGE_GLOBAL_WORKSPACE_ID = "000000000000000000000000";
// The counter key that holds a workspace's all-time total (the daily counters use the date, for example "2026-10-31").
export const STORAGE_TOTAL_KEY = "total";
// Daily counters tidy themselves away after this long.
export const STORAGE_COUNTER_KEEP_DAYS = 40;

// ---------- showing runs ----------

// What a person sees for a run: its saved status, or "unfinished" for a run that says "running" but has gone quiet.
export const DISPLAY_STATUSES = [...RUN_STATUSES, "unfinished"] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];
// A run still "running" with no update for this long is shown as "unfinished". Only the display changes, never the saved run.
export const UNFINISHED_AFTER_MS = 60 * 60 * 1000;
export const DEFAULT_RUNS_PAGE_SIZE = 20;
export const MAX_RUNS_PAGE_SIZE = 50;

// ---------- forks ----------

// Where a step came from. Steps the SDK recorded are "recorded". In a fork:
//   copied     before the fork point, copied from the original
//   rerun      an AI step that was asked again through the AI model
//   simulated  a tool or lookup that did NOT run; its recorded result was reused
//   edited     a tool or lookup that did NOT run; its result was typed in by a person
export const STEP_ORIGINS = ["recorded", "copied", "rerun", "simulated", "edited"] as const;
export type StepOrigin = (typeof STEP_ORIGINS)[number];

export const MAX_LLM_STEPS_PER_FORK = 20; // each one is a call to the AI model, which can cost money

// ---------- keeping AI costs under control ----------
// A fork asks an AI model, and with a real provider that costs the owner money. Anyone can start forks,
// including visitors to the demo, so every fork is capped in how long, how often and how big.
export const MAX_ANSWER_TOKENS = 1500; // the longest answer one AI call may give
export const AI_CALL_TIMEOUT_MS = 30_000; // one AI call
export const FORK_TIME_LIMIT_MS = 90_000; // a whole fork, all its AI calls together
export const MAX_FORKS_PER_DAY_REAL_PROVIDER = 30; // per workspace, per UTC day, when forks use a paid AI provider
export const MAX_FORKS_PER_DAY_DEMO_PROVIDER = 100; // the free scripted demo model costs nothing, so the limit is higher
export const MAX_FORK_EDITS = 50;
export const FORK_NAME_SUFFIX = " (fork)";
// Only text at least this long is swapped into later steps; a short answer like "ok" would match too much.
export const MIN_REPLACEABLE_TEXT_LENGTH = 8;

// ---------- links to other systems (AgentGuard) ----------

export const EXTERNAL_REF_URL_MAX = 500;
export const EXTERNAL_REF_ID_MAX = 200;
export const EXTERNAL_REF_SYSTEM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
// Only steps linked to this system get the "Undo the original actions" list.
export const AGENTGUARD_SYSTEM = "agentguard";

// ---------- tests and suites ----------

// What a saved test can check about the AI's answer. contains / not_contains / equals look at the words;
// max_cost (US dollars) and max_ms (milliseconds) look at what the answer cost and how long it took.
export const CHECK_TYPES = ["contains", "not_contains", "equals", "max_cost", "max_ms"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

// How the answer of a test run compares with the same test's previous run.
export const RESULT_CHANGES = ["improved", "same", "worse", "new", "not_run"] as const;
export type ResultChange = (typeof RESULT_CHANGES)[number];
// passed / failed: the checks were run. error: the AI could not be asked. skipped: the suite ran out of time first.
export const RESULT_OUTCOMES = ["passed", "failed", "error", "skipped"] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

// Running all tests asks the AI once per test, which can cost money with a paid provider, so it is bounded like forks.
export const MAX_TESTS_PER_WORKSPACE = 20; // also the most AI calls one "Run all" can make
export const MAX_CHECKS_PER_TEST = 10;
export const MAX_CHECK_TEXT_LENGTH = 500;
export const TEST_CONCURRENCY = 5; // tests asked at the same time
export const SUITE_TIME_LIMIT_MS = 90_000; // a whole "Run all"
export const MAX_TEST_AI_CALLS_PER_DAY_REAL_PROVIDER = 100; // per workspace, per UTC day, with a paid provider
export const MAX_TEST_AI_CALLS_PER_DAY_DEMO_PROVIDER = 500;
export const MAX_TEST_OUTPUT_BYTES = 4 * 1024; // the answer kept with a result (checks look at the whole answer)
export const TEST_RESULT_KEEP_DAYS = 30; // old results delete themselves
export const MAX_TEST_NAME_LENGTH = 120;

// ---------- keeping the counters honest ----------
// How often the server looks at its housekeeping jobs. Each job has its own interval, and only one server wins each run.
export const MAINTENANCE_CHECK_EVERY_MS = 60 * 60 * 1000;
// The daily clean-up works out each workspace's real storage total again, because deletes (old test results, demo reset) lower it.
export const STORAGE_CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;
