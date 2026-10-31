import { Plus, Trash2 } from "lucide-react";
import { DisplayButton } from "components/display_components";
import { CHECK_META } from "utils/helper_functions/format";
import { Check, CheckType } from "utils/types";

// What a person types for a check. Cost is typed in dollars and time in seconds; the API wants dollars and milliseconds.
export interface CheckDraft {
  key: number;
  type: CheckType;
  text: string;
}

const MAX_CHECKS = 10;
let nextKey = 1;

export const newDraft = (type: CheckType = "contains", text = ""): CheckDraft => ({ key: nextKey++, type, text });

export function checksToDrafts(checks: Check[]): CheckDraft[] {
  return checks.map((check) => newDraft(check.type, check.type === "max_ms" ? String(Number(check.value) / 1000) : String(check.value)));
}

/** Turns what was typed into checks, or says in plain words what to fix. */
export function draftsToChecks(drafts: CheckDraft[]): { checks: Check[]; problem: string } {
  if (drafts.length === 0) return { checks: [], problem: "Add at least one check, or the test could never fail." };
  const checks: Check[] = [];
  for (const draft of drafts) {
    const text = draft.text.trim();
    const kind = CHECK_META[draft.type].kind;
    if (!text) return { checks: [], problem: kind === "words" ? "Please type the words to look for in every check." : "Please type a number in every check." };
    if (kind === "words") {
      checks.push({ type: draft.type, value: text });
      continue;
    }
    const number = Number(text);
    if (!Number.isFinite(number) || number <= 0) return { checks: [], problem: "Cost and time must be numbers bigger than 0." };
    checks.push(draft.type === "max_ms" ? { type: "max_ms", value: Math.max(1, Math.round(number * 1000)) } : { type: "max_cost", value: number });
  }
  return { checks, problem: "" };
}

// The list of checks, with a way to add and remove them.
export const CheckEditor = ({ drafts, onChange, idPrefix }: { drafts: CheckDraft[]; onChange: (drafts: CheckDraft[]) => void; idPrefix: string }) => {
  const change = (key: number, changes: Partial<CheckDraft>) => onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...changes } : draft)));
  return (
    <div>
      <ul className="flex flex-col gap-3">
        {drafts.map((draft, position) => {
          const meta = CHECK_META[draft.type];
          return (
            <li key={draft.key} className="rounded-md border border-line p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="sm:w-72">
                  <label htmlFor={`${idPrefix}-type-${draft.key}`} className="field-label">
                    Check {position + 1}
                  </label>
                  <select id={`${idPrefix}-type-${draft.key}`} className="field-input" value={draft.type} onChange={(event) => change(draft.key, { type: event.target.value as CheckType })}>
                    {(Object.keys(CHECK_META) as CheckType[]).map((type) => (
                      <option key={type} value={type}>
                        {CHECK_META[type].label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-0 flex-1">
                  <label htmlFor={`${idPrefix}-value-${draft.key}`} className="sr-only">
                    {meta.label}
                  </label>
                  <input
                    id={`${idPrefix}-value-${draft.key}`}
                    className="field-input"
                    inputMode={meta.kind === "words" ? "text" : "decimal"}
                    maxLength={500}
                    placeholder={meta.placeholder}
                    value={draft.text}
                    onChange={(event) => change(draft.key, { text: event.target.value })}
                  />
                </div>
                <DisplayButton variant="ghost" aria-label={`Remove check ${position + 1}`} onClick={() => onChange(drafts.filter((item) => item.key !== draft.key))} icon={<Trash2 className="h-4 w-4" aria-hidden />}>
                  Remove
                </DisplayButton>
              </div>
            </li>
          );
        })}
      </ul>
      {drafts.length < MAX_CHECKS && (
        <DisplayButton className="mt-3" onClick={() => onChange([...drafts, newDraft()])} icon={<Plus className="h-4 w-4" aria-hidden />}>
          Add a check
        </DisplayButton>
      )}
    </div>
  );
};
