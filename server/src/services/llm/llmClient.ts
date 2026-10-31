import { env } from "../../config/env";
import { ServiceUnavailableError } from "../../helpers/errors";
import { demoReply } from "./demoProvider";

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
}

const DEFAULT_MODELS: Record<string, string> = {
  demo: "demo-model",
  openai: "gpt-4.1-mini",
  anthropic: "claude-haiku-4-5",
  ollama: "llama3.1",
};

const TIMEOUT_MS = 45_000;

export function isLlmConfigured(): boolean {
  if (env.LLM_PROVIDER === "demo" || env.LLM_PROVIDER === "ollama") return true;
  return Boolean(env.LLM_API_KEY);
}

export function llmDescription() {
  return {
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL || DEFAULT_MODELS[env.LLM_PROVIDER] || "",
    configured: isLlmConfigured(),
  };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
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

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

// Roughly one token for every four letters, for the scripted demo model (real models report their own counts).
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export async function completeChat(request: ChatRequest): Promise<ChatResult> {
  if (!isLlmConfigured()) {
    throw new ServiceUnavailableError("AI is not set up on this server. Set LLM_PROVIDER (and LLM_API_KEY) in server/env/local.env.");
  }
  const model = request.model || env.LLM_MODEL || DEFAULT_MODELS[env.LLM_PROVIDER];

  if (env.LLM_PROVIDER === "demo") {
    const everything = [request.system || "", ...request.messages.map((message) => message.content)].join("\n");
    const text = demoReply(everything);
    return { text, model, inputTokens: estimateTokens(everything), outputTokens: estimateTokens(text) };
  }

  if (env.LLM_PROVIDER === "openai") {
    const baseUrl = env.LLM_BASE_URL || "https://api.openai.com/v1";
    const data = await postJson(
      `${baseUrl}/chat/completions`,
      { authorization: `Bearer ${env.LLM_API_KEY}` },
      { model, temperature: 0, messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages] }
    );
    return {
      text: requireText(data?.choices?.[0]?.message?.content),
      model: String(data?.model || model),
      inputTokens: count(data?.usage?.prompt_tokens),
      outputTokens: count(data?.usage?.completion_tokens),
    };
  }

  if (env.LLM_PROVIDER === "anthropic") {
    const data = await postJson(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": env.LLM_API_KEY, "anthropic-version": "2023-06-01" },
      { model, max_tokens: 1500, temperature: 0, ...(request.system ? { system: request.system } : {}), messages: request.messages }
    );
    return {
      text: requireText((data?.content || []).map((part: { text?: string }) => part.text || "").join("")),
      model: String(data?.model || model),
      inputTokens: count(data?.usage?.input_tokens),
      outputTokens: count(data?.usage?.output_tokens),
    };
  }

  // ollama
  const baseUrl = env.LLM_BASE_URL || "http://127.0.0.1:11434";
  const data = await postJson(`${baseUrl}/api/chat`, {}, {
    model,
    stream: false,
    options: { temperature: 0 },
    messages: [...(request.system ? [{ role: "system", content: request.system }] : []), ...request.messages],
  });
  return {
    text: requireText(data?.message?.content),
    model: String(data?.model || model),
    inputTokens: count(data?.prompt_eval_count),
    outputTokens: count(data?.eval_count),
  };
}
