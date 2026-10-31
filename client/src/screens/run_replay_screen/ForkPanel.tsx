import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, CircleDot, GitFork, Search, ShieldCheck, Wrench } from "lucide-react";
import { DisplayButton, DisplayError, DisplayLoading, DisplayTip } from "components/display_components";
import { useForkRun, useStepDetail } from "utils/hooks/useAgentReplayQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { plural, STEP_TYPE_META } from "utils/helper_functions/format";
import { ForkEdit, StepOutline, StepType } from "utils/types";

const ICON: Record<StepType, typeof Bot> = { llm: Bot, tool: Wrench, retrieval: Search, custom: CircleDot };

// For a tool step further on: what it will return, with a way to change it.
const LaterToolStep = ({ runId, step, value, onChange }: { runId: string; step: StepOutline; value: string | undefined; onChange: (text: string | undefined) => void }) => {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useStepDetail(runId, open ? step.index : null);
  const Icon = ICON[step.type];
  return (
    <li className="rounded-md border border-line px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <Icon className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
          <span className="truncate font-medium">
            {step.index + 1}. {step.name || "Untitled step"}
          </span>
          <span className="text-ink-soft">will not run. It gives the result it gave before.</span>
        </p>
        <button type="button" onClick={() => setOpen(!open)} className="text-sm font-semibold text-brand underline" aria-expanded={open}>
          {open ? "Hide" : "Change what it returns"}
        </button>
      </div>
      {open && (
        <div className="mt-2">
          {isLoading && <DisplayLoading label="Loading" />}
          {data && (
            <>
              <label htmlFor={`later-${step.index}`} className="field-label">
                What it returns
              </label>
              <textarea
                id={`later-${step.index}`}
                rows={3}
                className="field-input font-sans"
                value={value ?? data.output}
                onChange={(event) => onChange(event.target.value === data.output ? undefined : event.target.value)}
              />
              {data.error && <p className="mt-1 text-xs text-ink-faint">It failed before. If you type a result here, the fork pretends it worked.</p>}
            </>
          )}
        </div>
      )}
    </li>
  );
};

// Set up a fork: change one step, see what will be asked again and what will not run, then start it.
export const ForkPanel = ({ runId, from, steps, onCancel }: { runId: string; from: StepOutline; steps: StepOutline[]; onCancel: () => void }) => {
  const navigate = useNavigate();
  const fork = useForkRun(runId);
  const { data: step, isLoading, error } = useStepDetail(runId, from.index);
  const isAi = from.type === "llm";
  const [prompt, setPrompt] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [laterOutputs, setLaterOutputs] = useState<Record<number, string>>({});

  // A different step starts a new form.
  useEffect(() => {
    setPrompt(null);
    setModel(null);
    setOutput(null);
    setLaterOutputs({});
    fork.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.index]);

  const later = steps.filter((item) => item.index > from.index);
  const askedAgain = (isAi ? 1 : 0) + later.filter((item) => item.type === "llm").length;
  const simulated = (isAi ? 0 : 1) + later.filter((item) => item.type !== "llm").length;

  const start = () => {
    if (!step) return;
    const edits: Record<number, ForkEdit> = {};
    if (isAi) {
      const edit: ForkEdit = {};
      if (prompt !== null && prompt !== (step.editablePrompt ?? "")) edit.prompt = prompt;
      if (model !== null && model.trim() && model.trim() !== from.model) edit.model = model.trim();
      if (Object.keys(edit).length > 0) edits[from.index] = edit;
    } else if (output !== null && output !== step.output) {
      edits[from.index] = { output };
    }
    Object.entries(laterOutputs).forEach(([index, text]) => (edits[Number(index)] = { output: text }));
    fork.mutate({ fromStepIndex: from.index, edits }, { onSuccess: (result) => navigate(`/runs/${result.run.id}/compare`) });
  };

  const FromIcon = ICON[from.type];
  return (
    <div>
      <p className="text-sm text-ink-soft">Fork from step {from.index + 1}</p>
      <h2 className="mt-0.5 flex items-center gap-2 break-words text-xl font-semibold">
        <GitFork className="h-5 w-5 shrink-0 text-brand" aria-hidden />
        Try this step again with a change
      </h2>

      <p className="mt-3 flex items-start gap-2 rounded-lg border border-done/30 bg-done-tint px-4 py-3 text-sm text-done" role="note">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          <strong>Tools are simulated in a fork. Nothing real happens.</strong> No email is sent, no refund is paid and no database is changed. Your original run is never changed
          either: the fork is saved as a new run.
        </span>
      </p>

      <p className="mt-3 text-sm text-ink-soft">
        Steps before this one are copied. From here on, <DisplayTip term="AI steps" meaning={STEP_TYPE_META.llm.hint} /> are asked again, and tools and lookups are not run: they give the result they gave before, unless you
        change it below.
      </p>

      {isLoading && <DisplayLoading label="Loading this step" />}
      {error && <div className="mt-3"><DisplayError message={getErrorMessage(error)} /></div>}

      {step && (
        <section className="mt-5 rounded-lg border border-line p-4">
          <h3 className="flex items-center gap-2 font-semibold">
            <FromIcon className="h-4 w-4 text-ink-faint" aria-hidden />
            {from.index + 1}. {from.name || "Untitled step"}
          </h3>
          {isAi ? (
            <>
              <label htmlFor="forkPrompt" className="field-label mt-3">
                What the AI is asked
              </label>
              <textarea id="forkPrompt" rows={6} className="field-input font-sans" value={prompt ?? step.editablePrompt ?? ""} onChange={(event) => setPrompt(event.target.value)} />
              <p className="mt-1 text-xs text-ink-faint">Change the words, fix the information in it, or leave it as it is to ask again. The AI's answer can be different each time.</p>
              <label htmlFor="forkModel" className="field-label mt-3">
                AI model
              </label>
              <input id="forkModel" className="field-input" maxLength={80} value={model ?? from.model} onChange={(event) => setModel(event.target.value)} placeholder="Leave as it is to use the same model" />
            </>
          ) : (
            <>
              <label htmlFor="forkOutput" className="field-label mt-3">
                What this step returns
              </label>
              <textarea id="forkOutput" rows={5} className="field-input font-sans" value={output ?? step.output} onChange={(event) => setOutput(event.target.value)} />
              <p className="mt-1 text-xs text-ink-faint">This step will not run. Type the result you want to pretend it gave, or leave it to reuse the recorded one.</p>
            </>
          )}
        </section>
      )}

      {later.length > 0 && (
        <section className="mt-5">
          <h3 className="text-sm font-semibold">The steps after it</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {later.map((item) =>
              item.type === "llm" ? (
                <li key={item.index} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
                  <Bot className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  <span className="truncate font-medium">
                    {item.index + 1}. {item.name || "Untitled step"}
                  </span>
                  <span className="text-ink-soft">will be asked again.</span>
                </li>
              ) : (
                <LaterToolStep
                  key={item.index}
                  runId={runId}
                  step={item}
                  value={laterOutputs[item.index]}
                  onChange={(text) =>
                    setLaterOutputs((current) => {
                      const next = { ...current };
                      if (text === undefined) delete next[item.index];
                      else next[item.index] = text;
                      return next;
                    })
                  }
                />
              )
            )}
          </ul>
        </section>
      )}

      <p className="mt-5 text-sm text-ink-soft">
        {askedAgain > 0 ? `${plural(askedAgain, "AI step")} will be asked again` : "No AI steps will be asked"}, and {plural(simulated, "step")} will be simulated.
      </p>
      {fork.error && (
        <div className="mt-3">
          <DisplayError message={getErrorMessage(fork.error)} />
        </div>
      )}
      <p className="mt-2 text-xs text-ink-faint">Asking the AI can take a few seconds. A fork that takes longer than 90 seconds is stopped and nothing is saved.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <DisplayButton variant="primary" size="lg" loading={fork.isPending} disabled={!step} onClick={start} icon={<GitFork className="h-4 w-4" aria-hidden />}>
          {fork.isPending ? "Starting the fork" : "Start the fork"}
        </DisplayButton>
        <DisplayButton size="lg" onClick={onCancel} disabled={fork.isPending}>
          Cancel
        </DisplayButton>
      </div>
    </div>
  );
};
