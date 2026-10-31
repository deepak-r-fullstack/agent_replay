import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Lightbulb, X } from "lucide-react";
import { DisplayButton, DisplayError, DisplayLoading } from "components/display_components";
import { useCreateTest, useStepDetail } from "utils/hooks/useAgentReplayQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { showToast } from "utils/store/toastStore";
import { CheckEditor, CheckDraft, draftsToChecks, newDraft } from "./CheckEditor";

export interface CheckSuggestions {
  mention: string[]; // words the answer should now contain
  avoid: string[]; // words the answer should no longer contain
}

// "Save as test": remember what the AI was asked, and what a good answer must look like.
export const SaveAsTestDialog = ({
  runId,
  stepIndex,
  defaultName,
  suggestions,
  onClose,
}: {
  runId: string;
  stepIndex: number;
  defaultName: string;
  suggestions?: CheckSuggestions;
  onClose: () => void;
}) => {
  const { data: step, isLoading, error } = useStepDetail(runId, stepIndex);
  const create = useCreateTest();
  const [name, setName] = useState(defaultName);
  const [drafts, setDrafts] = useState<CheckDraft[]>(() => [newDraft("contains")]);
  const [problem, setProblem] = useState("");
  const [saved, setSaved] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && !create.isPending && onClose();
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [create.isPending, onClose]);

  // A suggestion fills the empty first check, or becomes a new one.
  const addSuggestion = (type: "contains" | "not_contains", text: string) => {
    if (drafts.some((draft) => draft.type === type && draft.text.trim() === text)) return;
    const empty = drafts.length === 1 && !drafts[0].text.trim();
    setDrafts(empty ? [newDraft(type, text)] : [...drafts, newDraft(type, text)]);
  };

  const save = () => {
    const { checks, problem: found } = draftsToChecks(drafts);
    if (!name.trim()) return setProblem("Please give the test a name.");
    if (found) return setProblem(found);
    setProblem("");
    create.mutate(
      { name: name.trim(), sourceRunId: runId, stepIndex, checks },
      {
        onSuccess: () => {
          setSaved(true);
          showToast("Saved as a test.");
        },
      }
    );
  };

  const hasSuggestions = suggestions && (suggestions.mention.length > 0 || suggestions.avoid.length > 0);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={() => !create.isPending && onClose()} aria-hidden />
      <div role="dialog" aria-modal="true" aria-labelledby="save-test-title" className="relative max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-xl bg-sheet p-5 shadow-xl sm:rounded-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id="save-test-title" className="text-xl font-semibold">
            Save as a test
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-soft hover:bg-ink/5 hover:text-ink">
            <X className="h-5 w-5" />
          </button>
        </div>

        {saved ? (
          <div className="mt-4">
            <p className="rounded-lg border border-done/30 bg-done-tint px-4 py-3 text-done" role="status">
              Saved. You can run it with all your other tests, any time, to see if answers stay good.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link to="/tests">
                <DisplayButton variant="primary">See my tests</DisplayButton>
              </Link>
              <DisplayButton onClick={onClose}>Keep looking at this run</DisplayButton>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-soft">A test remembers what the AI was asked. Later you can ask it again and check that the answer is still good.</p>

            <label htmlFor="testName" className="field-label mt-4">
              Name of the test
            </label>
            <input id="testName" ref={nameRef} className="field-input" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />

            <h3 className="mt-4 text-sm font-semibold">What the AI will be asked</h3>
            {isLoading && <DisplayLoading label="Loading" />}
            {error && <DisplayError message={getErrorMessage(error)} />}
            {step && <p className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper px-3 py-2 text-sm">{step.editablePrompt || step.input}</p>}

            <h3 className="mt-4 text-sm font-semibold">What a good answer looks like</h3>
            {hasSuggestions && (
              <div className="mt-2 rounded-md border border-brand/20 bg-brand-tint px-3 py-2 text-sm">
                <p className="flex items-center gap-2 font-medium text-brand">
                  <Lightbulb className="h-4 w-4" aria-hidden /> Suggested from what changed
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {suggestions.mention.map((text) => (
                    <button key={`m-${text}`} type="button" onClick={() => addSuggestion("contains", text)} className="rounded-full border border-done/40 bg-sheet px-3 py-1 text-done hover:bg-done-tint">
                      Must mention {text}
                    </button>
                  ))}
                  {suggestions.avoid.map((text) => (
                    <button key={`a-${text}`} type="button" onClick={() => addSuggestion("not_contains", text)} className="rounded-full border border-refused/40 bg-sheet px-3 py-1 text-refused hover:bg-refused-tint">
                      Must not mention {text}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3">
              <CheckEditor drafts={drafts} onChange={setDrafts} idPrefix="save" />
            </div>

            {problem && (
              <div className="mt-3">
                <DisplayError message={problem} />
              </div>
            )}
            {create.error && (
              <div className="mt-3">
                <DisplayError message={getErrorMessage(create.error)} />
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <DisplayButton variant="primary" size="lg" loading={create.isPending} onClick={save}>
                Save test
              </DisplayButton>
              <DisplayButton size="lg" onClick={onClose} disabled={create.isPending}>
                Cancel
              </DisplayButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
