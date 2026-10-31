import { Check, Copy, ExternalLink, GitFork } from "lucide-react";
import { useState } from "react";
import { DisplayButton, DisplayError, DisplayLoading, DisplayTip } from "components/display_components";
import { useStepDetail } from "utils/hooks/useAgentReplayQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatCost, formatDuration, formatTokens, safeLink, STEP_ORIGIN_META, STEP_TYPE_META } from "utils/helper_functions/format";
import { showToast } from "utils/store/toastStore";

// Objects that were recorded as text are easier to read when laid out; everything else is shown as it was.
function readable(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

export const TextBlock = ({ title, text, emptyNote }: { title: string; text: string; emptyNote: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("Could not copy. Select the text and copy it by hand.", "error");
    }
  };
  return (
    <section className="mt-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {text && (
          <button type="button" onClick={copy} className="inline-flex items-center gap-1 text-xs font-medium text-ink-soft hover:text-ink">
            {copied ? <Check className="h-3.5 w-3.5 text-done" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      {text ? (
        <pre tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper px-3 py-2 font-sans text-sm leading-relaxed">
          {readable(text)}
        </pre>
      ) : (
        <p className="rounded-md border border-dashed border-line px-3 py-2 text-sm text-ink-faint">{emptyNote}</p>
      )}
      {text.endsWith("[cut at 32 KB]") && <p className="mt-1 text-xs text-ink-faint">This text was very long, so only the first 32 KB was saved.</p>}
    </section>
  );
};

export const Fact = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div>
    <dt className="text-xs text-ink-faint">{hint ? <DisplayTip term={label} meaning={hint} /> : label}</dt>
    <dd className="text-sm font-medium">{value}</dd>
  </div>
);

// "agentguard" -> "AgentGuard" is not always right, so only the one system we know gets a special spelling.
const systemName = (system: string) => (system === "agentguard" ? "AgentGuard" : system);

// What went into one step and what came out, with its time, tokens and cost.
export const StepDetailPanel = ({ runId, index, onFork }: { runId: string; index: number; onFork?: () => void }) => {
  const { data: step, isLoading, error, refetch } = useStepDetail(runId, index);

  if (isLoading) return <DisplayLoading label="Loading this step" />;
  if (error || !step) return <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />;

  const type = STEP_TYPE_META[step.type];
  const origin = STEP_ORIGIN_META[step.origin];
  const link = step.externalRef ? safeLink(step.externalRef.url) : null;
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-ink-soft">
            <DisplayTip term={type.label} meaning={type.hint} /> · step {step.index + 1}
          </p>
          <h2 className="mt-0.5 break-words text-xl font-semibold">{step.name || "Untitled step"}</h2>
        </div>
        {onFork && (
          <DisplayButton onClick={onFork} icon={<GitFork className="h-4 w-4" aria-hidden />}>
            Fork from this step
          </DisplayButton>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Fact label="Time taken" value={formatDuration(step.durationMs)} />
        <Fact label="Tokens" value={formatTokens(step.tokens)} hint="Tokens are the pieces of text an AI model reads and writes. More tokens means a higher cost." />
        <Fact label="Cost" value={formatCost(step.costUsd)} hint="A dash means no cost was recorded for this step." />
        <Fact label="AI model" value={step.model || "—"} />
      </dl>

      {origin && step.origin !== "copied" && (
        <p className="mt-4 rounded-lg border border-line bg-paper px-4 py-3 text-sm text-ink-soft">
          <span className="font-semibold text-ink">{origin.label}.</span> {origin.note}
        </p>
      )}

      {step.note && (
        <p className="mt-4 rounded-lg border border-waiting/30 bg-waiting-tint px-4 py-3 text-sm text-waiting" role="note">
          {step.note}
        </p>
      )}

      {step.error && (
        <div className="mt-4 rounded-lg border border-refused/30 bg-refused-tint px-4 py-3 text-refused" role="alert">
          <p className="font-semibold">This step failed</p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">{step.error}</p>
        </div>
      )}

      {step.externalRef && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-3">
          <p className="min-w-0 text-sm">
            <span className="font-semibold">Linked to {systemName(step.externalRef.system)}.</span>{" "}
            <span className="break-all text-ink-soft">Record {step.externalRef.id}</span>
          </p>
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand underline">
              Open in {systemName(step.externalRef.system)} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          )}
        </div>
      )}

      <TextBlock title="What went in" text={step.input} emptyNote="Nothing was recorded for this." />
      <TextBlock title="What came out" text={step.output} emptyNote={step.error ? "Nothing came out, because the step failed." : "Nothing was recorded for this."} />

      <p className="mt-4 text-xs text-ink-faint">For your safety, secrets such as keys, emails and card numbers were hidden before this was saved.</p>
    </div>
  );
};
