import { Run } from "./run";
import { PriceOptions, WrapOptions } from "./types";

// Helpers that record an AI provider's calls without changing what the call does or returns.
// The wrapped client gives back the very same result (or throws the very same error) as the original.
// Streaming calls are passed through untouched and are not recorded in this version.

type AnyFunction = (...args: unknown[]) => unknown;
type Loose = Record<string, unknown>;

// Walks `path` (for example chat -> completions -> create) and wraps only the last function.
// Everything else on the client behaves exactly as before.
function wrapPath<T extends object>(root: T, path: string[], wrapFunction: (original: AnyFunction, owner: object) => AnyFunction): T {
  const make = (target: object, depth: number): object =>
    new Proxy(target, {
      get(owner, property) {
        const value = Reflect.get(owner, property, owner);
        // A frozen client forbids a proxy from returning anything but the real value. Hand it back as it is:
        // the call still works, it just is not recorded (use run.trace for those clients).
        const descriptor = Reflect.getOwnPropertyDescriptor(owner, property);
        if (descriptor && !descriptor.configurable && (descriptor.writable === false || (!descriptor.get && !descriptor.set && !descriptor.writable))) {
          return value;
        }
        if (depth < path.length && property === path[depth]) {
          if (depth === path.length - 1 && typeof value === "function") return wrapFunction(value as AnyFunction, owner);
          if (value && typeof value === "object") return make(value as object, depth + 1);
        }
        // Bound to the real object, so the client's own private state keeps working through the proxy.
        return typeof value === "function" ? (value as AnyFunction).bind(owner) : value;
      },
    });
  try {
    return make(root, 0) as T;
  } catch {
    return root;
  }
}

function asRecord(value: unknown): Loose {
  return value && typeof value === "object" ? (value as Loose) : {};
}

function costOf(price: PriceOptions | undefined, inputTokens: number, outputTokens: number) {
  if (!price) return 0;
  return (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface Extracted {
  output: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// Records one call. `extract` reads the provider's response; if it cannot, the step is still recorded, just thinner.
function trackCall(
  run: Run,
  name: string,
  price: PriceOptions | undefined,
  extract: (response: unknown) => Extracted,
  original: AnyFunction,
  owner: object
): AnyFunction {
  return function wrapped(...args: unknown[]) {
    const request = asRecord(args[0]);
    // Streaming responses are not recorded in this version.
    if (request.stream) return original.apply(owner, args);

    let index = 0;
    const startedAt = Date.now();
    try {
      index = run.reserveIndex();
    } catch {
      return original.apply(owner, args);
    }
    const input = { model: request.model, system: request.system, messages: request.messages };
    const finish = (response: unknown, error: unknown) => {
      try {
        const extracted = error === undefined ? extract(response) : { output: undefined, model: String(request.model ?? ""), inputTokens: 0, outputTokens: 0 };
        run.record(
          index,
          {
            type: "llm",
            name,
            input,
            output: extracted.output,
            model: extracted.model || String(request.model ?? ""),
            tokens: extracted.inputTokens + extracted.outputTokens,
            costUsd: costOf(price, extracted.inputTokens, extracted.outputTokens),
            durationMs: Date.now() - startedAt,
            error,
          },
          startedAt
        );
      } catch {
        // Recording problems never reach the host app.
      }
    };

    let result: unknown;
    try {
      result = original.apply(owner, args);
    } catch (error) {
      finish(undefined, error ?? new Error("unknown error"));
      throw error;
    }
    const thenable = result as { then?: (...handlers: unknown[]) => unknown } | null;
    if (thenable && typeof thenable.then === "function") {
      // Watch the promise on the side and hand back the original, so extras like .withResponse() keep working.
      try {
        thenable.then(
          (response: unknown) => finish(response, undefined),
          (error: unknown) => finish(undefined, error ?? new Error("unknown error"))
        );
      } catch {
        // Ignore: watching is optional.
      }
    } else {
      finish(result, undefined);
    }
    return result;
  };
}

function openAiExtract(response: unknown): Extracted {
  const body = asRecord(response);
  const usage = asRecord(body.usage);
  const choice = asRecord((Array.isArray(body.choices) ? body.choices[0] : undefined) as unknown);
  const message = asRecord(choice.message);
  return {
    output: message.content ?? message.tool_calls ?? undefined,
    model: typeof body.model === "string" ? body.model : "",
    inputTokens: number(usage.prompt_tokens),
    outputTokens: number(usage.completion_tokens),
  };
}

function anthropicExtract(response: unknown): Extracted {
  const body = asRecord(response);
  const usage = asRecord(body.usage);
  const blocks = Array.isArray(body.content) ? body.content : [];
  const text = blocks
    .map((block) => asRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  return {
    output: text || (blocks.length ? blocks : undefined),
    model: typeof body.model === "string" ? body.model : "",
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
  };
}

/** Records every `client.chat.completions.create(...)` call as an AI step of `run`. */
export function wrapOpenAI<T extends object>(client: T, run: Run, options: WrapOptions = {}): T {
  return wrapPath(client, ["chat", "completions", "create"], (original, owner) =>
    trackCall(run, options.name ?? "chat.completions.create", options.price, openAiExtract, original, owner)
  );
}

/** Records every `client.messages.create(...)` call as an AI step of `run`. */
export function wrapAnthropic<T extends object>(client: T, run: Run, options: WrapOptions = {}): T {
  return wrapPath(client, ["messages", "create"], (original, owner) =>
    trackCall(run, options.name ?? "messages.create", options.price, anthropicExtract, original, owner)
  );
}
