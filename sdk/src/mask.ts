// Hides secrets in text before it leaves the app: API keys, emails and card numbers.
// The AgentReplay server runs the same rules again (server/src/utils/mask.ts), so keep the two files in step.
// Every pattern is written to run in a single pass over the text (no nested repeats),
// so even a 32 KB prompt is masked in a few milliseconds and can never freeze the host app.

const SECRET = "[secret hidden]";
const EMAIL = "[email hidden]";
const CARD = "[card hidden]";

// Keys that start with a well-known prefix.
const KEY_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, // Authorization headers
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic and similar
  /\bar_[0-9a-f]{48}\b/g, // AgentReplay SDK keys
  /\bagk_[0-9a-f]{48}\b/g, // AgentGuard agent keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JSON web tokens
];

// `password: hunter22`, `"api_key": "abc123"`, `token=xyz789`: keep the name, hide the value.
// Values that already start with "[" are earlier replacements, so masking twice changes nothing.
const NAMED_VALUE = /\b(api[_-]?key|secret|token|password|passwd)\b(["']?\s*[:=]\s*["']?)(?!\[)([^\s"',;]{6,})/gi;

// The lookbehind makes each address start only at the beginning of a run of address characters,
// which keeps the search linear even for long strings like "a.a.a.a.a...".
const EMAIL_PATTERN = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

// 13 to 19 digits, optionally split by spaces or dashes. The Luhn check keeps order numbers and dates safe.
const CARD_PATTERN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

function passesLuhn(digits: string) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

export function maskSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  for (const pattern of KEY_PATTERNS) result = result.replace(pattern, SECRET);
  result = result.replace(NAMED_VALUE, (_match, name: string, separator: string) => `${name}${separator}${SECRET}`);
  result = result.replace(EMAIL_PATTERN, EMAIL);
  result = result.replace(CARD_PATTERN, (match) => {
    const digits = match.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits) ? CARD : match;
  });
  return result;
}
