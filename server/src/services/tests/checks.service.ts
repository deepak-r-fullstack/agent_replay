import { CheckType } from "../../constants";

// The simple checks a saved test makes on an AI answer. Written in plain words so that a failed check says what to look at.

export interface Check {
  type: CheckType;
  value: string | number;
}

export interface FailedCheck extends Check {
  message: string;
}

export interface AnswerFacts {
  costUsd: number; // 0 means the price is not known, so a cost check cannot fail
  durationMs: number;
}

// Spaces and line breaks do not matter when comparing words.
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const shorten = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
const dollars = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} seconds`;

/** Returns the checks the answer did not pass, each with a message a person can read. Empty means everything passed. */
export function evaluateChecks(output: string, facts: AnswerFacts, checks: Check[]): FailedCheck[] {
  const answer = squash(output);
  const lower = answer.toLowerCase();
  const failed: FailedCheck[] = [];
  for (const check of checks) {
    const text = String(check.value);
    // Words are matched ignoring capital letters, so "refund" also finds "Refund".
    if (check.type === "contains" && !lower.includes(squash(text).toLowerCase())) {
      failed.push({ ...check, message: `The answer should mention "${shorten(text)}", but it does not.` });
    } else if (check.type === "not_contains" && lower.includes(squash(text).toLowerCase())) {
      failed.push({ ...check, message: `The answer should not mention "${shorten(text)}", but it does.` });
    } else if (check.type === "equals" && answer !== squash(text)) {
      failed.push({ ...check, message: `The answer should be exactly "${shorten(text)}", but it is different.` });
    } else if (check.type === "max_cost" && facts.costUsd > Number(check.value)) {
      failed.push({ ...check, message: `The answer cost ${dollars(facts.costUsd)}, but it should cost no more than ${dollars(Number(check.value))}.` });
    } else if (check.type === "max_ms" && facts.durationMs > Number(check.value)) {
      failed.push({ ...check, message: `The answer took ${seconds(facts.durationMs)}, but it should take no more than ${seconds(Number(check.value))}.` });
    }
  }
  return failed;
}
