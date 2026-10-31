import { KeyboardEvent, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { AlertTriangle, ArrowLeft, Bot, CircleDot, GitCompare, GitFork, Hourglass, Search, Wrench } from "lucide-react";
import { DisplayButton, DisplayError, DisplayLoading, DisplayStatusBadge, DisplayTip } from "components/display_components";
import { useRun } from "utils/hooks/useAgentReplayQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatCost, formatDuration, formatTokens, plural, STEP_ORIGIN_META, STEP_TYPE_META, timeAgo } from "utils/helper_functions/format";
import { useAuthStore } from "utils/store/authStore";
import { StepOutline, StepType } from "utils/types";
import { SaveAsTestDialog } from "screens/tests_screen/SaveAsTestDialog";
import { ForkPanel } from "./ForkPanel";
import { StepDetailPanel } from "./StepDetailPanel";

const STEP_ICON: Record<StepType, typeof Bot> = { llm: Bot, tool: Wrench, retrieval: Search, custom: CircleDot };

const RunFact = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div>
    <dt className="text-xs text-ink-faint">{hint ? <DisplayTip term={label} meaning={hint} /> : label}</dt>
    <dd className="text-sm font-medium">{value}</dd>
  </div>
);

const TimelineItem = ({ step, selected, onSelect }: { step: StepOutline; selected: boolean; onSelect: () => void }) => {
  const Icon = STEP_ICON[step.type];
  const meta = STEP_TYPE_META[step.type];
  // In a fork, steps that were asked again or did not really run say so (the details explain what that means).
  const origin = step.origin === "recorded" || step.origin === "copied" ? "" : STEP_ORIGIN_META[step.origin]?.label || "";
  const facts = [meta.label, formatDuration(step.durationMs), step.tokens ? `${formatTokens(step.tokens)} tokens` : "", origin].filter((part) => part && part !== "—");
  return (
    <li>
      <button
        type="button"
        id={`step-${step.index}`}
        onClick={onSelect}
        aria-current={selected ? "step" : undefined}
        className={`flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
          step.failed
            ? selected
              ? "border-refused bg-refused-tint"
              : "border-refused/40 bg-refused-tint/50 hover:bg-refused-tint"
            : selected
              ? "border-brand bg-brand-tint"
              : "border-transparent hover:bg-ink/5"
        }`}
      >
        <span
          className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.failed ? "bg-refused text-white" : "bg-ink/10 text-ink-soft"}`}
          aria-hidden
        >
          {step.index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <Icon className={`h-4 w-4 shrink-0 ${step.failed ? "text-refused" : "text-ink-faint"}`} aria-hidden />
            <span className="truncate font-medium">{step.name || "Untitled step"}</span>
          </span>
          <span className="mt-0.5 block text-xs text-ink-soft">{facts.join(" · ")}</span>
        </span>
        {step.failed && <span className="shrink-0 rounded-full bg-refused px-2 py-0.5 text-xs font-semibold text-white">Failed</span>}
      </button>
    </li>
  );
};

// One run, step by step: the timeline on the left, what went in and out of the chosen step on the right.
export const RunReplayScreen = () => {
  const { id = "" } = useParams();
  const location = useLocation();
  const backTo = (location.state as { backTo?: string } | null)?.backTo || "/runs";
  const { data, isLoading, error, refetch } = useRun(id);
  const [chosen, setChosen] = useState<number | null>(null);
  const [forkingFrom, setForkingFrom] = useState<number | null>(null);
  const [savingTestFor, setSavingTestFor] = useState<number | null>(null);
  const role = useAuthStore((state) => state.user?.role);
  // Viewers can look at runs but cannot start forks.
  const canFork = role === "owner" || role === "developer";
  const detailRef = useRef<HTMLDivElement>(null);

  const backLink = (
    <Link to={backTo} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink">
      <ArrowLeft className="h-4 w-4" aria-hidden /> All runs
    </Link>
  );

  if (isLoading) return <>{backLink}<DisplayLoading label="Loading this run" /></>;
  if (error || !data) {
    return (
      <>
        {backLink}
        <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />
      </>
    );
  }

  const { run, steps } = data;
  const failedSteps = steps.filter((step) => step.failed);
  // Open on the first failed step if there is one, so the problem is the first thing you see.
  const selected = chosen !== null && steps.some((step) => step.index === chosen) ? chosen : (failedSteps[0] ?? steps[0])?.index ?? null;

  const select = (index: number, scroll = true) => {
    setChosen(index);
    setForkingFrom(null);
    // On a phone the details sit below the timeline, so bring them into view.
    if (scroll && window.innerWidth < 1024) detailRef.current?.scrollIntoView({ block: "start" });
  };

  // Arrow keys walk the timeline, like a list.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const position = steps.findIndex((step) => step.index === selected);
    const next = steps[position + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    select(next.index, false);
    document.getElementById(`step-${next.index}`)?.focus();
  };

  const who = [run.userRef && `for ${run.userRef}`, run.appName].filter(Boolean).join(" · ");

  return (
    <>
      {backLink}
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="break-words text-2xl font-semibold tracking-tight">{run.name}</h1>
          <DisplayStatusBadge status={run.displayStatus} explain />
        </div>
        <p className="mt-1 text-ink-soft">
          Started {timeAgo(run.startedAt)}
          {who && ` · ${who}`}
        </p>
        <p className="mt-1 text-sm text-ink-soft">Click a step to see what went in and what came out.</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
          <RunFact label="Steps" value={String(run.stepCount)} />
          <RunFact label="Time taken" value={formatDuration(run.durationMs)} />
          <RunFact label="Tokens" value={formatTokens(run.totalTokens)} hint="Tokens are the pieces of text an AI model reads and writes." />
          <RunFact label="Cost" value={formatCost(run.costUsd)} hint="A dash means no cost was recorded." />
          <RunFact label="AI model" value={run.model || "—"} />
        </dl>
      </header>

      {run.parentRunId && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-sheet px-4 py-3 text-sm">
          <GitFork className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
          <span>
            This run is a fork (a re-run with a change).{" "}
            {run.parentRunName ? (
              <>
                It started from{" "}
                <Link to={`/runs/${run.parentRunId}`} className="font-semibold text-brand underline">
                  {run.parentRunName}
                </Link>
                .
              </>
            ) : (
              "The run it started from is no longer available."
            )}
          </span>
          {run.parentRunName && (
            <Link to={`/runs/${run.id}/compare`} className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-semibold text-brand underline">
              <GitCompare className="h-4 w-4" aria-hidden /> Compare with the original
            </Link>
          )}
        </p>
      )}

      {failedSteps.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-refused/30 bg-refused-tint px-4 py-3 text-refused" role="status">
          <p className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              {plural(failedSteps.length, "step")} failed. The first one is step {failedSteps[0].index + 1}, {failedSteps[0].name || "untitled"}.
            </span>
          </p>
          {selected !== failedSteps[0].index && (
            <DisplayButton variant="danger" onClick={() => select(failedSteps[0].index)}>
              Show me
            </DisplayButton>
          )}
        </div>
      )}

      {run.displayStatus === "unfinished" && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-waiting/30 bg-waiting-tint px-4 py-3 text-waiting" role="status">
          <Hourglass className="h-4 w-4 shrink-0" aria-hidden />
          <span>This run never reported that it finished, and nothing has been heard from it for over an hour. The app may have stopped. The steps below are everything that was recorded.</span>
        </p>
      )}
      {run.displayStatus === "running" && (
        <p className="mb-4 rounded-lg border border-line bg-sheet px-4 py-3 text-sm text-ink-soft" role="status">
          This run is still going. New steps appear here by themselves.
        </p>
      )}

      {steps.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-sheet px-6 py-10 text-center text-ink-soft">
          No steps have been recorded for this run yet.
        </p>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <section aria-label="Steps" className="rounded-lg border border-line bg-sheet p-2">
            <ol className="flex flex-col gap-1" onKeyDown={onKeyDown}>
              {steps.map((step) => (
                <TimelineItem key={step.index} step={step} selected={step.index === selected} onSelect={() => select(step.index)} />
              ))}
            </ol>
          </section>
          <section ref={detailRef} aria-label="Step details" className="min-w-0 scroll-mt-4 rounded-lg border border-line bg-sheet p-5">
            {forkingFrom !== null && steps.some((step) => step.index === forkingFrom) ? (
              <ForkPanel runId={run.id} from={steps.find((step) => step.index === forkingFrom)!} steps={steps} onCancel={() => setForkingFrom(null)} />
            ) : (
              selected !== null && <StepDetailPanel key={selected} runId={run.id} index={selected} onFork={canFork ? () => setForkingFrom(selected) : undefined} onSaveAsTest={canFork ? () => setSavingTestFor(selected) : undefined} />
            )}
          </section>
        </div>
      )}

      {savingTestFor !== null && <SaveAsTestDialog runId={run.id} stepIndex={savingTestFor} defaultName={run.name} onClose={() => setSavingTestFor(null)} />}
    </>
  );
};
