import { randomBytes } from "crypto";
import { prepareText } from "./text";
import { Transport } from "./transport";
import { RunStatus, StartRunOptions, StepInput, StepRecord, StepType, TraceOptions } from "./types";

// The server keeps at most this many steps per run, so extra steps are not even queued.
const MAX_STEPS_PER_RUN = 1000;
const MAX_NAME_LENGTH = 120;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

// Short random text that names a run before the server has seen it.
function newRunId() {
  try {
    return randomBytes(12).toString("hex");
  } catch {
    return Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }
}

// Error messages often repeat the input (an email, a key), so they get the same masking as everything else.
function errorToText(error: unknown): string {
  return prepareText(error instanceof Error ? `${error.name}: ${error.message}` : error, 4 * 1024);
}

function cleanNumber(value: unknown, whole: boolean) {
  const number = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  return whole ? Math.round(number) : number;
}

// One run of an AI feature: a numbered list of steps. Every method is safe to call anywhere:
// none of them throws, and none of them waits for the network.
export class Run {
  readonly id: string;
  private readonly startedAtMs = Date.now();
  private nextStepIndex = 0;
  private anyStepFailed = false;
  private ended = false;

  /** @internal Created by AgentReplay.startRun. */
  constructor(private readonly transport: Transport, options: StartRunOptions = {}) {
    this.id = newRunId();
    try {
      this.transport.enqueueRun({
        id: this.id,
        name: options.name ? prepareText(options.name).slice(0, MAX_NAME_LENGTH) : undefined,
        userRef: options.userRef ? prepareText(options.userRef).slice(0, MAX_NAME_LENGTH) : undefined,
        tags: options.tags?.slice(0, MAX_TAGS).map((tag) => prepareText(tag).slice(0, MAX_TAG_LENGTH)),
        status: "running",
        startedAt: new Date(this.startedAtMs).toISOString(),
      });
    } catch {
      // Recording problems never reach the host app.
    }
  }

  /** @internal Reserves the next step number, so steps keep the order they started in. */
  reserveIndex(): number {
    return this.nextStepIndex++;
  }

  /** @internal Records a finished step at a number reserved earlier. */
  record(index: number, step: StepInput, startedAtMs: number) {
    try {
      if (index >= MAX_STEPS_PER_RUN) return;
      const error = step.error === undefined || step.error === null || step.error === "" ? "" : errorToText(step.error);
      if (error) this.anyStepFailed = true;
      const type: StepType = step.type ?? "custom";
      const record: StepRecord = {
        runId: this.id,
        index,
        type,
        name: prepareText(step.name).slice(0, MAX_NAME_LENGTH),
        input: prepareText(step.input),
        output: prepareText(step.output),
        model: typeof step.model === "string" ? step.model.slice(0, 80) : "",
        tokens: cleanNumber(step.tokens, true),
        costUsd: cleanNumber(step.costUsd, false),
        durationMs: cleanNumber(step.durationMs, true),
        error,
        startedAt: new Date(startedAtMs).toISOString(),
      };
      this.transport.enqueueStep(record);
    } catch {
      // Dropped quietly on purpose.
    }
  }

  /** Records a step that has already happened. */
  step(step: StepInput): void {
    try {
      this.record(this.reserveIndex(), step, Date.now() - cleanNumber(step.durationMs, true));
    } catch {
      // Dropped quietly on purpose.
    }
  }

  /**
   * Runs your function, times it, and records the result (or the error) as one step.
   * Your function's result and errors come back exactly as they were.
   */
  async trace<T>(type: StepType, name: string, work: () => Promise<T> | T, options: TraceOptions<T> = {}): Promise<T> {
    const index = this.reserveIndex();
    const startedAtMs = Date.now();
    try {
      const result = await work();
      this.recordTraced(index, startedAtMs, type, name, options, { result });
      return result;
    } catch (error) {
      this.recordTraced(index, startedAtMs, type, name, options, { error });
      throw error;
    }
  }

  private recordTraced<T>(
    index: number,
    startedAtMs: number,
    type: StepType,
    name: string,
    options: TraceOptions<T>,
    outcome: { result?: T; error?: unknown }
  ) {
    try {
      const failed = "error" in outcome;
      let output: unknown = outcome.result;
      if (!failed && options.output) output = options.output(outcome.result as T);
      this.record(
        index,
        {
          type,
          name,
          input: options.input,
          output: failed ? undefined : output,
          model: options.model,
          tokens: options.tokens,
          costUsd: options.costUsd,
          durationMs: Date.now() - startedAtMs,
          error: failed ? outcome.error : undefined,
        },
        startedAtMs
      );
    } catch {
      // A broken "output" function must not break the host's call either.
    }
  }

  /** Marks the run as finished. Without a status it is "failed" if any step failed, otherwise "ok". */
  end(status?: Exclude<RunStatus, "running">): void {
    try {
      if (this.ended) return;
      this.ended = true;
      this.transport.enqueueRun({
        id: this.id,
        status: status ?? (this.anyStepFailed ? "failed" : "ok"),
        durationMs: Math.max(0, Date.now() - this.startedAtMs),
      });
    } catch {
      // Dropped quietly on purpose.
    }
  }

  /** Sends everything waiting right now. Resolves even if AgentReplay cannot be reached. */
  async flush(): Promise<void> {
    try {
      await this.transport.flush();
    } catch {
      // Never rejects.
    }
  }
}
