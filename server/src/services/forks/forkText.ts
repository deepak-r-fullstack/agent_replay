import { MIN_REPLACEABLE_TEXT_LENGTH } from "../../constants";
import { ChatMessage } from "../llm/llmClient";

// Reading and changing the text an AI step was asked. The SDK's wrappers record it as JSON like
// {"model":"...","system":"...","messages":[{"role":"user","content":"..."}]}; steps recorded by hand are plain text.
// Both are handled, so "the prompt" is always something a person can read and change.

interface ChatInput {
  raw: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
}

function parseChatInput(input: string): ChatInput | null {
  const text = input.trim();
  if (!text.startsWith("{")) return null;
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && Array.isArray(raw.messages) && raw.messages.every((message: unknown) => message && typeof message === "object")) {
      return { raw, messages: raw.messages };
    }
  } catch {
    // Not JSON (or cut in the middle): treated as plain text below.
  }
  return null;
}

const contentOf = (message: Record<string, unknown>) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""));

function lastUserIndex(messages: Array<Record<string, unknown>>) {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === "user") return index;
  return messages.length - 1;
}

/** The text a person edits: the last thing the user said, or the whole input for plain-text steps. */
export function editablePromptOf(input: string): string {
  const chat = parseChatInput(input);
  if (!chat) return input;
  return chat.messages.length > 0 ? contentOf(chat.messages[lastUserIndex(chat.messages)]) : "";
}

/** Puts a person's new prompt in place of the last user message (or the whole input), keeping everything else. */
export function applyPromptEdit(input: string, prompt: string): string {
  const chat = parseChatInput(input);
  if (!chat || chat.messages.length === 0) return prompt;
  const index = lastUserIndex(chat.messages);
  const messages = chat.messages.map((message, position) => (position === index ? { ...message, content: prompt } : message));
  return JSON.stringify({ ...chat.raw, messages });
}

function replaceAll(text: string, from: string, to: string) {
  return text.split(from).join(to);
}

export interface Replacement {
  from: string;
  to: string;
}

/**
 * When an earlier step now says something different, later steps that quoted its old answer word for word get the
 * new answer instead, so a fix flows downstream. Short texts are skipped: "ok" would match far too much.
 */
export function applyReplacements(input: string, replacements: Replacement[]): string {
  const usable = replacements.filter((item) => item.from.length >= MIN_REPLACEABLE_TEXT_LENGTH && item.from !== item.to);
  if (usable.length === 0) return input;
  const swap = (text: string) => usable.reduce((current, item) => replaceAll(current, item.from, item.to), text);
  const chat = parseChatInput(input);
  if (!chat) return swap(input);
  const messages = chat.messages.map((message) => (typeof message.content === "string" ? { ...message, content: swap(message.content) } : message));
  const system = typeof chat.raw.system === "string" ? swap(chat.raw.system) : chat.raw.system;
  return JSON.stringify({ ...chat.raw, ...(system !== undefined ? { system } : {}), messages });
}

/** What to send to the AI model: a system text plus the user and assistant messages. */
export function chatRequestFrom(input: string): { system?: string; messages: ChatMessage[] } {
  const chat = parseChatInput(input);
  if (!chat) return { messages: [{ role: "user", content: input }] };
  const systemParts: string[] = typeof chat.raw.system === "string" && chat.raw.system ? [chat.raw.system] : [];
  const messages: ChatMessage[] = [];
  for (const message of chat.messages) {
    const content = contentOf(message);
    if (message.role === "system") systemParts.push(content);
    else messages.push({ role: message.role === "assistant" ? "assistant" : "user", content });
  }
  // A model needs something to answer.
  if (messages.length === 0) messages.push({ role: "user", content: systemParts.join("\n") || "Hello" });
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages };
}
