import { env } from "../../config/env";
import { AI_CALL_TIMEOUT_MS, MAX_ANSWER_TOKENS } from "../../constants";
import { ServiceUnavailableError } from "../../helpers/errors";
import { DEMO_MODELS, demoReply } from "./demoProvider";

// ---------------------------------------------------------------------------
// One tiny, provider-agnostic way to ask a model a question. No SDKs: plain fetch,
// so switching demo <-> OpenAI <-> Claude <-> Ollama is one env change.
// Forks use it to ask AI steps again. It is the ONLY thing a fork can run:
// tool and lookup steps are never run (see forks/fork.service.ts).
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string; // the model name the step used, or the one a person chose
  system?: string;
  messages: ChatMessage[];
}

export interface ChatResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number; // from the prices in the settings; 0 or missing when not known
}

const DEFAULT_MODELS: Record<string, string> = {
  demo: "demo-model",
  openai: "gpt-4.1-mini",
  anthropic: "claude-haiku-4-5",
  ollama: "llama3.1",
};

export interface ChatOptions {
  // The free scripted demo model, whatever LLM_PROVIDER says. Used for the demo workspace, which is open to anyone.
  forceDemo?: boolean;
  // How long this one call may take before it is given up. Defaults to the limit for a single AI call.
  timeoutMs?: number;
  // Called at the moment a request is about to be sent to a real (paid) provider, and never for the free demo model or
  // for a call that fails before it is sent. Forks use it to know whether money may have been spent.
  onProviderCall?: () => void;
}

/** True when answers come from the free scripted demo model, so nothing is spent. */
export function usesDemoProvider(forceDemo = false): boolean {
  return forceDemo || env.LLM_PROVIDER === "demo";
}

export function isLlmConfigured(): boolean {
  if (env.LLM_PROVIDER === "demo" || env.LLM_PROVIDER === "ollama") return true;
  return Boolean(env.LLM_API_KEY);
}

// The model used when nobody asked for one, or when the one asked for is not allowed.
function fallbackModel() {
  return env.LLM_MODEL || DEFAULT_MODELS[env.LLM_PROVIDER];
}

/** The models someone can pick from: the free demo models, or the allowed models of the paid provider. */
export function modelChoices(forceDemo = false): string[] {
  return usesDemoProvider(forceDemo) ? [...DEMO_MODELS] : allowedModels();
}

/** The model used when none is picked. */
export function defaultModel(forceDemo = false): string {
  return usesDemoProvider(forceDemo) ? DEFAULT_MODELS.demo : fallbackModel();
}

/** The models a fork may use with a paid provider: the ones on LLM_ALLOWED_MODELS, plus LLM_MODEL itself. */
export function allowedModels(): string[] {
  return [...new Set([...env.LLM_ALLOWED_MODELS, fallbackModel()])];
}

/**
 * Chooses the model a fork really uses. With a paid provider, a model that is not on the allow-list is replaced by
 * LLM_MODEL (so nobody can pick an expensive one), and the note says so. The free demo model costs nothing, so there
 * the name is only a label and is kept as it was asked for.
 */
export function resolveModel(requested: string, forceDemo = false): { model: string; note: string } {
  const wanted = (requested || "").trim();
  if (usesDemoProvider(forceDemo)) return { model: wanted || DEFAULT_MODELS.demo, note: "" };
  const fallback = fallbackModel();
  if (!wanted) return { model: fallback, note: "" };
  if (allowedModels().includes(wanted)) return { model: wanted, note: "" };
  return { model: fallback, note: `Used ${fallback} instead of ${wanted}, which is not allowed here.` };
}

export function llmDescription() {
  return {
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL || DEFAULT_MODELS[env.LLM_PROVIDER] || "",
    configured: isLlmConfigured(),
  };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, onProviderCall?: () => void): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    onProviderCall?.();
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Do not pass the provider's error body on: it can echo the prompt.
      throw new ServiceUnavailableError(`The AI service answered with status ${response.status}. Check the model name and try again.`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof ServiceUnavailableError) throw err;
    if (controller.signal.aborted) {
      throw new ServiceUnavailableError(`The AI took too long to answer (over ${Math.round(timeoutMs / 1000)} seconds), so it was stopped. Nothing was saved. Please try again.`);
    }
    throw new ServiceUnavailableError("Could not reach the AI service. Check the AI settings and try again.");
  } finally {
    clearTimeout(timer);
  }
}

function requireText(text: unknown): string {
  const answer = typeof text === "string" ? text.trim() : "";
  if (!answer) throw new ServiceUnavailableError("The AI did not give an answer. Please try again.");
  return answer;
}

// Works out the cost from the prices in the settings (US dollars per million tokens). 0 when they are not set.
function costOf(inputTokens: number, outputTokens: number) {
  return (inputTokens * env.LLM_INPUT_PRICE_PER_MILLION + outputTokens * env.LLM_OUTPUT_PRICE_PER_MILLION) / 1_000_000;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

// Roughly one token for every four letters, for the scripted demo model (real models report their own counts).
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export async function completeChat(request: ChatRequest, options: ChatOptions = {}): Promise<ChatResult> {
  const timeoutMs = options.timeoutMs ?? AI_CALL_TIMEOUT_MS;

  if (usesDemoProvider(options.forceDemo)) {
    const model = resolveModel(request.model, true).model;
    const everything = [request.system || "", ...request.messages.map((message) => message.content)].join("\n");
    const text = demoReply(everything, model);
    return { text, model, inputTokens: estimateTokens(everything), outputTokens: estimateTokens(text) };
  }

  if (!isLlmConfigured()) {
    throw new ServiceUnavailableError("AI is not set up on this server. Set LLM_PROVIDER (and LLM_API_KEY) in server/env/local.env.");
  }
  // Checked again here, so no caller can ask a paid provider for a model that is not allowed.
  const model = resolveModel(request.model).model;

  if (env.LLM_PROVIDER === "openai") {
    const baseUrl = env.LLM_BASE_URL || "https://api.openai.com/v1";
    const data = await postJson(
      `${baseUrl}/chat/completions`,
      { authorization: `Bearer ${env.LLM_API_KEY}` },
      {
        model,
        temperature: 0,
        // OpenAI itself asks for max_completion_tokens; gateways that copy its API still expect the older max_tokens.
        ...(env.LLM_BASE_URL ? { max_tokens: MAX_ANSWER_TOKENS } : { max_completion_tokens: MAX_ANSWER_TOKENS }),
        messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages],
      },
      timeoutMs,
      options.onProviderCall
    );
    const inputTokens = count(data?.usage?.prompt_tokens);
    const outputTokens = count(data?.usage?.completion_tokens);
    return { text: requireText(data?.choices?.[0]?.message?.content), model: String(data?.model || model), inputTokens, outputTokens, costUsd: costOf(inputTokens, outputTokens) };
  }

  if (env.LLM_PROVIDER === "anthropic") {
    const data = await postJson(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": env.LLM_API_KEY, "anthropic-version": "2023-06-01" },
      { model, max_tokens: MAX_ANSWER_TOKENS, temperature: 0, ...(request.system ? { system: request.system } : {}), messages: request.messages },
      timeoutMs,
      options.onProviderCall
    );
    const inputTokens = count(data?.usage?.input_tokens);
    const outputTokens = count(data?.usage?.output_tokens);
    return {
      text: requireText((data?.content || []).map((part: { text?: string }) => part.text || "").join("")),
      model: String(data?.model || model),
      inputTokens,
      outputTokens,
      costUsd: costOf(inputTokens, outputTokens),
    };
  }

  // ollama
  const baseUrl = env.LLM_BASE_URL || "http://127.0.0.1:11434";
  const data = await postJson(
    `${baseUrl}/api/chat`,
    {},
    {
      model,
      stream: false,
      options: { temperature: 0, num_predict: MAX_ANSWER_TOKENS },
      messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages],
    },
    timeoutMs,
    options.onProviderCall
  );
  const inputTokens = count(data?.prompt_eval_count);
  const outputTokens = count(data?.eval_count);
  return { text: requireText(data?.message?.content), model: String(data?.model || model), inputTokens, outputTokens, costUsd: costOf(inputTokens, outputTokens) };
}
