import { DisplayStatus, StepOrigin, StepType, UserRole } from "utils/types";

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

// "just now", "5 min ago", "3 hr ago", then the date.
export function timeAgo(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatDateTime(value);
}

// A cost of 0 means none was recorded (the SDK needs prices to work it out), so it shows as a dash.
export function formatCost(usd: number) {
  if (!usd) return "—";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

export function formatTokens(tokens: number) {
  return tokens ? tokens.toLocaleString("en-IN") : "—";
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString("en-IN")} ${count === 1 ? one : many}`;
}

// Words people see for each role. Kept in one place so every screen says the same thing.
export const ROLE_LABEL: Record<UserRole, string> = { owner: "Owner", developer: "Developer", viewer: "Viewer" };

// Words people see for each run status, with a one-line explanation shown as a tooltip.
export const STATUS_META: Record<DisplayStatus, { label: string; tone: "done" | "waiting" | "refused" | "neutral"; hint: string }> = {
  running: { label: "Running", tone: "neutral", hint: "Still working. This page updates by itself." },
  ok: { label: "Done", tone: "done", hint: "The run finished and no step failed." },
  failed: { label: "Failed", tone: "refused", hint: "A step failed, or the app said the run failed." },
  unfinished: { label: "Unfinished", tone: "waiting", hint: "This run never reported that it finished. The app may have stopped." },
};

export const STEP_TYPE_META: Record<StepType, { label: string; hint: string }> = {
  llm: { label: "AI call", hint: "A question sent to an AI model, and its answer." },
  tool: { label: "Tool", hint: "An action the app took, such as sending an email or paying a refund." },
  retrieval: { label: "Lookup", hint: "Fetching information, such as searching a database or documents." },
  custom: { label: "Step", hint: "Anything else the app chose to record." },
};

// How a step in a fork was made, in plain words. Steps the SDK recorded have no label.
export const STEP_ORIGIN_META: Partial<Record<StepOrigin, { label: string; note: string }>> = {
  copied: { label: "Copied", note: "Copied from the original run, exactly as it was." },
  rerun: { label: "Asked again", note: "The AI was asked again for this fork, so its answer may be different from the original." },
  simulated: { label: "Simulated", note: "This did not run. Tools are simulated in a fork: nothing real happens. The result the original run recorded was reused." },
  edited: { label: "You typed the result", note: "This did not run. Tools are simulated in a fork: nothing real happens. The result below is the one you typed." },
};

// Only https links open from the app, plus http://localhost links while developing. The server checks this too.
export function safeLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return null;
    const ok = parsed.protocol === "https:" || (import.meta.env.DEV && parsed.protocol === "http:" && parsed.hostname === "localhost");
    return ok ? parsed.toString() : null;
  } catch {
    return null;
  }
}
