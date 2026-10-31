import { EXTERNAL_REF_URL_MAX } from "../constants";
import { maskSecrets } from "./mask";

// A link from a step to a record in another system, for example the AgentGuard action that step caused.
// The SDK follows the same rules before sending (sdk/src/externalRef.ts), so keep the two files in step.
// Links are shown as buttons that open in a new tab, so they are held to strict rules.

// https:// links only, or http://localhost links while developing (never in production).
// No user name or password inside the link, and nothing that looks like a secret.
export function isAllowedLinkUrl(raw: string, production: boolean): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > EXTERNAL_REF_URL_MAX) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const allowed = url.protocol === "https:" || (!production && url.protocol === "http:" && url.hostname === "localhost");
  return allowed && maskSecrets(raw) === raw;
}
