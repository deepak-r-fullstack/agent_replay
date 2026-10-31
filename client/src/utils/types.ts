// Shapes returned by the AgentReplay API (see server controllers).

export type UserRole = "owner" | "developer" | "viewer";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  workspaceId: string;
  workspaceName: string;
  isDemo?: boolean; // true in the shared demo workspace
}

export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

export interface AppSummary {
  id: string;
  name: string;
  apiKeyPreview: string;
  active: boolean;
  seeded?: boolean; // made by the demo seed: its key cannot be changed
  createdAt: string;
}

// Only create and rotate return the full key, and only once.
export interface AppWithKey extends AppSummary {
  apiKey: string;
}

export interface SignupInput {
  name: string;
  workspaceName: string;
  email: string;
  password: string;
}

// ---------- runs and replay ----------

// What a person sees for a run. "unfinished" is a run that says "running" but has had no update for an hour.
export type DisplayStatus = "running" | "ok" | "failed" | "unfinished";
export type StepType = "llm" | "tool" | "retrieval" | "custom";
// Where a step came from: recorded by the SDK, or one of the ways a fork builds its steps.
export type StepOrigin = "recorded" | "copied" | "rerun" | "simulated" | "edited";

// A link to a record in another system, for example the AgentGuard action a step caused.
export interface ExternalRef {
  system: string;
  id: string;
  url: string;
}

export interface RunSummary {
  id: string;
  name: string;
  status: "running" | "ok" | "failed";
  displayStatus: DisplayStatus;
  userRef: string;
  model: string;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  stepCount: number;
  tags: string[];
  appId: string;
  appName: string;
  startedAt: string;
  lastActivityAt: string;
  parentRunId: string | null;
  forkedFromStepId: string | null;
}

export interface RunsPage {
  runs: RunSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RunFilters {
  q?: string;
  status?: DisplayStatus;
  appId?: string;
  from?: string;
  to?: string;
}

// One line of the timeline. The text of the step is fetched when it is opened.
export interface StepOutline {
  index: number;
  type: StepType;
  name: string;
  model: string;
  tokens: number;
  costUsd: number;
  durationMs: number;
  startedAt: string;
  origin: StepOrigin;
  // A short plain-words note, for example that a fork used a different AI model than the one asked for.
  note: string;
  failed: boolean;
}

export interface RunDetail {
  run: RunSummary & { parentRunName: string | null };
  steps: StepOutline[];
}

export interface StepDetail extends Omit<StepOutline, "failed"> {
  input: string;
  output: string;
  error: string;
  // The last thing an AI step was asked: the text a person changes when forking it. Null for steps that are not AI steps.
  editablePrompt: string | null;
  externalRef: ExternalRef | null;
}

// ---------- forks ----------

export interface ForkEdit {
  prompt?: string;
  model?: string;
  output?: string;
}

export interface ForkInput {
  fromStepIndex: number;
  edits: Record<number, ForkEdit>;
}

export interface ComparisonRow {
  index: number;
  type: StepType;
  name: string;
  origin: StepOrigin | null;
  changed: boolean;
  original: StepOutline | null;
  fork: StepOutline | null;
}

export interface UndoLink {
  index: number;
  name: string;
  id: string;
  url: string;
}

export interface RunComparison {
  original: RunSummary;
  fork: RunSummary & { parentRunName: string };
  forkedFromIndex: number;
  rows: ComparisonRow[];
  undoLinks: UndoLink[];
}

// ---------- tests and suites ----------

export type CheckType = "contains" | "not_contains" | "equals" | "max_cost" | "max_ms";

export interface Check {
  type: CheckType;
  value: string | number;
}

export interface FailedCheck extends Check {
  message: string;
}

// passed / failed: the checks were made. error: the AI could not be asked. skipped: the run ran out of time first.
export type ResultOutcome = "passed" | "failed" | "error" | "skipped";
// How the result compares with the same test's last run.
export type ResultChange = "improved" | "same" | "worse" | "new" | "not_run";

export interface TestResultInfo {
  suiteRunId: string;
  outcome: ResultOutcome;
  change: ResultChange;
  output: string;
  failedChecks: FailedCheck[];
  error: string;
  costUsd: number;
  durationMs: number;
  model: string;
  note: string;
  ranAt: string;
}

export interface TestSummary {
  id: string;
  name: string;
  sourceRunId: string;
  sourceStepIndex: number;
  model: string;
  prompt: string;
  checks: Check[];
  lastResult: TestResultInfo | null;
  createdAt: string;
}

export interface SuiteSummary {
  id: string;
  ranAt: string;
  model: string;
  improved: number;
  same: number;
  worse: number;
  new: number;
  notRun: number;
  total: number;
}

export interface TestsPage {
  tests: TestSummary[];
  latestSuite: SuiteSummary | null;
  modelChoices: string[];
  defaultModel: string;
  limits: { maxTests: number };
}

export interface SuiteRun {
  suite: SuiteSummary | null;
  summary: { total: number; improved: number; same: number; worse: number; new: number; notRun: number };
}

export interface CreateTestInput {
  name: string;
  sourceRunId: string;
  stepIndex?: number;
  checks: Check[];
}
