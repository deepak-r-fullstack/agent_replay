import { AgentReplayOptions, FetchLike, RunUpdate, StepRecord } from "./types";

// Sends recorded steps to AgentReplay in the background. The rules that keep the host app safe:
//  - recording only puts things in a small in-memory queue; nothing waits for the network
//  - sending happens on a timer, in batches, with a short timeout
//  - any failure drops that batch quietly; nothing is ever thrown to the host app
//  - after repeated failures it stops trying for a while (and drops what arrives) instead of piling up
//  - timers never keep the host process alive

const MAX_STEPS_PER_REQUEST = 500; // the server refuses more
const MAX_RUNS_PER_REQUEST = 50;
const MAX_REQUEST_CHARS = 1_500_000; // keeps each request well under the server's size limit
const MAX_QUEUED_RUNS = 1000;
const SEND_NOW_AT_STEPS = 100;
const FAILURES_BEFORE_PAUSE = 3;
const PAUSE_AFTER_FAILURES_MS = 30_000;
const DEFAULT_RATE_LIMIT_PAUSE_S = 60;
const MAX_RATE_LIMIT_PAUSE_S = 300;

export const DEFAULT_BASE_URL = "https://agentreplay.sritaraksolutions.in";

interface QueuedStep {
  record: StepRecord;
  size: number;
}

export class Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike | null;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxQueuedSteps: number;
  private readonly debug: boolean;

  private runs = new Map<string, RunUpdate>();
  private steps: QueuedStep[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> = Promise.resolve();
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private stopped = false; // the key was refused: stop for good
  readonly enabled: boolean;

  constructor(options: AgentReplayOptions = {}) {
    const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
    this.apiKey = (options.apiKey ?? env.AGENTREPLAY_API_KEY ?? "").trim();
    const baseUrl = (options.baseUrl ?? env.AGENTREPLAY_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.endpoint = `${baseUrl}/api/ingest`;
    this.fetchImpl = options.fetch ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : null);
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.maxQueuedSteps = options.maxQueuedSteps ?? 5000;
    this.debug = options.debug ?? false;
    // Without a key (or when switched off) every call below is a harmless no-op.
    this.enabled = options.enabled !== false && this.apiKey.startsWith("ar_") && this.fetchImpl !== null;
    if (!this.enabled) this.log("recording is off (no valid SDK key found)");
  }

  enqueueRun(update: RunUpdate) {
    if (!this.canQueue()) return;
    const existing = this.runs.get(update.id);
    if (!existing && this.runs.size >= MAX_QUEUED_RUNS) return;
    // Later updates win, but a finished status is never taken back by a late "running".
    const merged: RunUpdate = { ...existing, ...update };
    if (existing?.status && existing.status !== "running" && update.status === "running") merged.status = existing.status;
    this.runs.set(update.id, merged);
    this.schedule();
  }

  enqueueStep(record: StepRecord) {
    if (!this.canQueue() || this.steps.length >= this.maxQueuedSteps) return;
    const size = record.input.length + record.output.length + record.error.length + record.name.length + 300;
    this.steps.push({ record, size });
    if (this.steps.length >= SEND_NOW_AT_STEPS) this.flushInBackground();
    else this.schedule();
  }

  /** Sends everything queued. Always resolves; never rejects. */
  flush(): Promise<void> {
    this.clearTimer();
    // One send at a time, in order, so batches cannot overtake each other.
    this.sending = this.sending.then(() => this.drain()).catch(() => undefined);
    return this.sending;
  }

  /** Test helper and a way to know how much is waiting. */
  get queuedSteps() {
    return this.steps.length;
  }

  private canQueue() {
    return this.enabled && !this.stopped && Date.now() >= this.pausedUntil;
  }

  private schedule() {
    if (this.timer || !this.enabled) return;
    this.timer = setTimeout(() => this.flushInBackground(), this.flushIntervalMs);
    // unref: a waiting timer alone must never keep the host process from exiting.
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private flushInBackground() {
    void this.flush();
  }

  private async drain() {
    while ((this.steps.length > 0 || this.runs.size > 0) && !this.stopped) {
      if (Date.now() < this.pausedUntil) {
        this.dropEverything();
        return;
      }
      const batch = this.takeBatch();
      await this.send(batch);
    }
  }

  private takeBatch() {
    const steps: StepRecord[] = [];
    let chars = 0;
    while (this.steps.length > 0 && steps.length < MAX_STEPS_PER_REQUEST) {
      const next = this.steps[0];
      if (steps.length > 0 && chars + next.size > MAX_REQUEST_CHARS) break;
      this.steps.shift();
      steps.push(next.record);
      chars += next.size;
    }
    const runs: RunUpdate[] = [];
    for (const [id, update] of this.runs) {
      if (runs.length >= MAX_RUNS_PER_REQUEST) break;
      runs.push(update);
      this.runs.delete(id);
    }
    return { runs, steps };
  }

  private async send(batch: { runs: RunUpdate[]; steps: StepRecord[] }) {
    if (!this.fetchImpl) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : undefined;
      // The timeout also covers a server that accepts the connection and then says nothing.
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller?.abort();
          reject(new Error("timeout"));
        }, this.timeoutMs);
        timeout.unref?.();
      });
      const request = this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey },
        body: JSON.stringify(batch),
        signal: controller?.signal,
      });
      request.catch(() => undefined); // if the timeout wins, a late failure must not become an unhandled rejection
      const response = await Promise.race([request, timedOut]);
      this.handleStatus(response.status, response.headers?.get("retry-after") ?? null);
    } catch {
      this.recordFailure();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private handleStatus(status: number, retryAfter: string | null) {
    if (status >= 200 && status < 300) {
      this.consecutiveFailures = 0;
    } else if (status === 401 || status === 403) {
      // The key is wrong or switched off. Retrying cannot help, so stop recording.
      this.stopped = true;
      this.dropEverything();
      this.log("the SDK key was refused; recording is stopped");
    } else if (status === 429) {
      const seconds = Math.min(Number(retryAfter) || DEFAULT_RATE_LIMIT_PAUSE_S, MAX_RATE_LIMIT_PAUSE_S);
      this.pausedUntil = Date.now() + seconds * 1000;
      this.dropEverything();
    } else if (status === 400 || status === 413) {
      // This batch itself is the problem. Drop it and carry on with the next one.
      this.consecutiveFailures = 0;
    } else {
      this.recordFailure();
    }
  }

  private recordFailure() {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURES_BEFORE_PAUSE) {
      this.pausedUntil = Date.now() + PAUSE_AFTER_FAILURES_MS;
      this.consecutiveFailures = 0;
      this.dropEverything();
      this.log("AgentReplay cannot be reached; pausing for 30 seconds");
    }
  }

  private dropEverything() {
    this.steps = [];
    this.runs.clear();
    this.clearTimer();
  }

  private log(message: string) {
    if (this.debug) console.warn(`[agentreplay] ${message}`);
  }
}
