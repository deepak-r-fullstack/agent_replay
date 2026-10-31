import { maskSecrets } from "./mask";

// A link from a step to a record in another system, for example the AgentGuard action that step caused.
// The AgentReplay server holds links to the same rules (server/src/utils/externalRef.ts), so keep the two files in step.
// A link that breaks the rules is left out and the step is still recorded: a bad link must never lose a step.

export interface ExternalRef {
  /** Lowercase name of the other system, for example "agentguard". */
  system: string;
  /** That system's own id for the record. */
  id: string;
  /** An https:// link to it (or http://localhost while developing). Up to 500 characters. */
  url: string;
}

const URL_MAX = 500;
const ID_MAX = 200;
const SYSTEM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function isAllowedUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > URL_MAX) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const production = typeof process !== "undefined" && process.env.NODE_ENV === "production";
  const allowed = url.protocol === "https:" || (!production && url.protocol === "http:" && url.hostname === "localhost");
  return allowed && maskSecrets(raw) === raw;
}

/** Returns the link if it follows the rules, or undefined. Never throws. */
export function cleanExternalRef(value: unknown): ExternalRef | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    const { system, id, url } = value as Record<string, unknown>;
    if (typeof system !== "string" || !SYSTEM_PATTERN.test(system)) return undefined;
    if (typeof id !== "string" || id.trim().length === 0) return undefined;
    if (typeof url !== "string" || !isAllowedUrl(url)) return undefined;
    return { system, id: maskSecrets(id.trim()).slice(0, ID_MAX), url };
  } catch {
    return undefined;
  }
}
