// Public types of the SDK.

export const STEP_TYPES = ["llm", "tool", "retrieval", "custom"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export type RunStatus = "running" | "ok" | "failed";

// What the server accepts (see server/src/controllers/ingest.controller.ts).
import { ExternalRef } from "./externalRef";

export interface RunUpdate {
  id: string;
  name?: string;
  userRef?: string;
  tags?: string[];
  status?: RunStatus;
  startedAt?: string;
  durationMs?: number;
}

export interface StepRecord {
  runId: string;
  index: number;
  type: StepType;
  name: string;
  input: string;
  output: string;
  model: string;
  tokens: number;
  costUsd: number;
  durationMs: number;
  error: string;
  startedAt: string;
  externalRef?: ExternalRef;
}

export interface FetchResponseLike {
  status: number;
  headers?: { get(name: string): string | null };
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<FetchResponseLike>;

export interface AgentReplayOptions {
  /** Your SDK key from the Apps and keys screen. Defaults to the AGENTREPLAY_API_KEY setting. */
  apiKey?: string;
  /** Where AgentReplay lives. Defaults to AGENTREPLAY_URL, then the hosted site. */
  baseUrl?: string;
  /** Turn recording off without removing any code. */
  enabled?: boolean;
  /** How often queued steps are sent in the background. Default 2000. */
  flushIntervalMs?: number;
  /** How long one send may take before it is given up. Default 3000. */
  timeoutMs?: number;
  /** Most steps kept waiting in memory. More are dropped. Default 5000. */
  maxQueuedSteps?: number;
  /** Print short problems (never your data) to the console. Default false. */
  debug?: boolean;
  /** For tests: replace the network call. */
  fetch?: FetchLike;
}

export interface StartRunOptions {
  name?: string;
  /** Who the run was for: a customer id, for example. Emails in it are hidden. */
  userRef?: string;
  tags?: string[];
}

export interface StepInput {
  type?: StepType;
  name: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  tokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** An Error or text. Marks the step as failed. */
  error?: unknown;
  /** A link to a record in another system, for example the AgentGuard action this step caused. */
  externalRef?: ExternalRef;
}

export interface TraceOptions<T = unknown> {
  input?: unknown;
  model?: string;
  tokens?: number;
  costUsd?: number;
  /** A link to a record in another system, for example the AgentGuard action this step caused. */
  externalRef?: ExternalRef;
  /** Choose what to record as the output. Defaults to the whole result. */
  output?: (result: T) => unknown;
}

export interface PriceOptions {
  /** US dollars per million tokens, used to work out each step's cost. */
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface WrapOptions {
  name?: string;
  price?: PriceOptions;
}
