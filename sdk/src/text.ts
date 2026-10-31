import { maskSecrets } from "./mask";

// Every piece of recorded text is capped, so one huge prompt cannot fill the free database.
// The server applies the same cap (server/src/utils/text.ts).
export const MAX_TEXT_BYTES = 32 * 1024;
const CUT_MARKER = "… [cut at 32 KB]";

export function capText(text: string, maxBytes = MAX_TEXT_BYTES): string {
  // Fast path: a string never takes more than 3 bytes per character.
  if (text.length * 3 <= maxBytes || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const room = maxBytes - Buffer.byteLength(CUT_MARKER, "utf8");
  // Cutting in the middle of a character leaves a broken character at the end; drop it.
  const kept = Buffer.from(text, "utf8").subarray(0, room).toString("utf8").replace(/�+$/, "");
  return kept + CUT_MARKER;
}

// Turns anything a developer hands us (text, objects, errors) into safe text. Never throws:
// circular objects, BigInts and odd values must not be able to break the host app.
export function toText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circular]";
        seen.add(item);
      }
      return item;
    });
    return json === undefined ? String(value) : json;
  } catch {
    return "[could not be recorded]";
  }
}

// The one way text is prepared for sending: cut it down first (so masking stays fast), hide secrets, cut again
// in case the replacement words made it a little longer.
export function prepareText(value: unknown, maxBytes = MAX_TEXT_BYTES): string {
  return capText(maskSecrets(capText(toText(value), maxBytes)), maxBytes);
}
