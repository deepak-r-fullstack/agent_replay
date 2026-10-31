// Shapes returned by the AgentReplay API (see server controllers).

export type UserRole = "owner" | "developer" | "viewer";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  workspaceId: string;
  workspaceName: string;
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
}
