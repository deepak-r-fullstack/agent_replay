import { maskSecrets } from "./mask";
import { MAX_STEP_TEXT_BYTES } from "../constants";

// Every piece of recorded text is capped, so one huge prompt cannot fill the free database.
// The SDK applies the same cap before sending (sdk/src/text.ts).
const CUT_MARKER = "… [cut at 32 KB]";

export function capText(text: string, maxBytes = MAX_STEP_TEXT_BYTES): string {
  // Fast path: a string never takes more than 3 bytes per character.
  if (text.length * 3 <= maxBytes || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const room = maxBytes - Buffer.byteLength(CUT_MARKER, "utf8");
  // Cutting in the middle of a character leaves a broken character at the end; drop it.
  const kept = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/�+$/, "");
  return kept + CUT_MARKER;
}

// The one way recorded text is prepared for saving: cut it down first (so masking stays fast), hide secrets,
// cut again in case the replacement words made it a little longer.
export function prepareText(text: string, maxBytes = MAX_STEP_TEXT_BYTES): string {
  return capText(maskSecrets(capText(text, maxBytes)), maxBytes);
}
