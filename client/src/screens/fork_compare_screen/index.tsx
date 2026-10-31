import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, ShieldCheck, Undo2 } from "lucide-react";
import { DisplayButton, DisplayError, DisplayLoading, DisplayTip } from "components/display_components";
import { useComparison, useStepDetail } from "utils/hooks/useAgentReplayQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatCost, formatDuration, formatTokens, safeLink, STEP_ORIGIN_META, STEP_TYPE_META } from "utils/helper_functions/format";
import { ComparisonRow, RunSummary, UndoLink } from "utils/types";
import { DiffText } from "./DiffText";

const Side = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="min-w-0">
    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</h4>
    {children}
  </div>
);

// One number from each run, with how much it moved.
const Stat = ({ label, hint, original, fork, delta }: { label: string; hint?: string; original: string; fork: string; delta?: string }) => (
  <div className="rounded-lg border border-line bg-sheet px-4 py-3">
    <p className="text-xs text-ink-faint">{hint ? <DisplayTip term={label} meaning={hint} /> : label}</p>
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-ink-soft">{original}</span>
      <span aria-label="became">→</span>
      <span className="text-base font-semibold">{fork}</span>
    </p>
    {delta && <p className="mt-0.5 text-xs text-ink-soft">{delta}</p>}
  </div>
);

// "+20%" or "−35%", or nothing when either number is missing (a cost of 0 means none was recorded).
function change(original: number, fork: number) {
  if (!original || !fork) return undefined;
  const percent = Math.round(((fork - original) / original) * 100);
  return percent === 0 ? "about the same" : `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
}

// The two answers (or the two versions of one step) side by side, with the different words marked.
const StepTexts = ({ original, fork, index, part }: { original: string; fork: string; index: number; part: "input" | "output" }) => {
  const { data: before, isLoading: loadingBefore, error: errorBefore } = useStepDetail(original, index);
  const { data: after, isLoading: loadingAfter, error: errorAfter } = useStepDetail(fork, index);
  if (loadingBefore || loadingAfter) return <DisplayLoading label="Loading" />;
  const failure = errorBefore || errorAfter;
  if (failure || !before || !after) return <DisplayError message={getErrorMessage(failure)} />;
  const emptyNote = before.error || after.error ? "Nothing came out." : "Nothing was recorded.";
  const textOf = (step: typeof before) => (part === "output" ? step.output || step.error : step.input);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Side label="Original">
        <DiffText side="original" before={textOf(before)} after={textOf(after)} emptyNote={emptyNote} />
      </Side>
      <Side label="Fork">
        <DiffText side="fork" before={textOf(before)} after={textOf(after)} emptyNote={emptyNote} />
      </Side>
    </div>
  );
};

// `answerShownAbove`: this step is the one the answer section already shows, so its output is not repeated here.
const ChangedRow = ({ row, originalId, forkId, answerShownAbove }: { row: ComparisonRow; originalId: string; forkId: string; answerShownAbove: boolean }) => {
  const [showAsked, setShowAsked] = useState(false);
  const origin = row.origin ? STEP_ORIGIN_META[row.origin] : undefined;
  return (
    <li className="rounded-lg border border-line bg-sheet p-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-semibold">
          Step {row.index + 1}: {row.name || "Untitled step"}
        </span>
        <span className="text-ink-soft">
          <DisplayTip term={STEP_TYPE_META[row.type].label} meaning={STEP_TYPE_META[row.type].hint} />
        </span>
        {origin && <span className="rounded-full bg-brand-tint px-2 py-0.5 text-xs font-semibold text-brand">{origin.label}</span>}
      </p>
      {row.fork?.note && (
        <p className="mt-2 rounded-md border border-waiting/30 bg-waiting-tint px-3 py-2 text-sm text-waiting" role="note">
          {row.fork.note}
        </p>
      )}
      {answerShownAbove ? (
        <p className="mt-2 text-sm text-ink-soft">The answer above comes from this step.</p>
      ) : (
        <div className="mt-3">
          <StepTexts original={originalId} fork={forkId} index={row.index} part="output" />
        </div>
      )}
      {row.type === "llm" && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowAsked(!showAsked)} className="text-sm font-semibold text-brand underline" aria-expanded={showAsked}>
            {showAsked ? "Hide what the AI was asked" : "Show what the AI was asked"}
          </button>
          {showAsked && (
            <div className="mt-2">
              <StepTexts original={originalId} fork={forkId} index={row.index} part="input" />
            </div>
          )}
        </div>
      )}
    </li>
  );
};

// The actions in AgentGuard that the original run caused. Undoing happens THERE, behind AgentGuard's own permissions and
// audit trail. AgentReplay only opens the page; it never calls AgentGuard.
const UndoList = ({ links }: { links: UndoLink[] }) => (
  <section className="mt-6 rounded-lg border border-waiting/30 bg-waiting-tint/50 p-5" aria-labelledby="undo-title">
    <h2 id="undo-title" className="flex items-center gap-2 text-lg font-semibold">
      <Undo2 className="h-5 w-5 text-waiting" aria-hidden /> Undo the original actions
    </h2>
    <p className="mt-1 text-sm text-ink-soft">
      The original run did these things for real. A fork never undoes anything, and AgentReplay cannot undo them either. To undo one, open it in AgentGuard. Only someone with permission there (a manager) can approve an undo,
      and AgentGuard keeps a record of it.
    </p>
    <ul className="mt-3 flex flex-col gap-2">
      {links.map((link) => {
        const href = safeLink(link.url);
        return (
          <li key={`${link.index}-${link.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-sheet px-4 py-3">
            <p className="min-w-0 text-sm">
              <span className="font-medium">
                Step {link.index + 1}: {link.name || "Untitled step"}
              </span>
              <span className="block break-all text-ink-faint">AgentGuard record {link.id}</span>
            </p>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-md border border-line bg-sheet px-3.5 py-1.5 text-sm font-medium text-ink transition-colors hover:border-ink-faint"
              >
                Open in AgentGuard to undo <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            ) : (
              <span className="text-sm text-ink-faint">This link cannot be opened.</span>
            )}
          </li>
        );
      })}
    </ul>
  </section>
);

// Which step is "the answer": the last AI step, or the last step if there is no AI step.
function answerIndex(rows: ComparisonRow[]) {
  const ai = [...rows].reverse().find((row) => row.type === "llm" && row.original && row.fork);
  return (ai ?? [...rows].reverse().find((row) => row.original && row.fork))?.index ?? null;
}

const RunLine = ({ run, label }: { run: RunSummary; label: string }) => (
  <Link to={`/runs/${run.id}`} className="font-semibold text-brand underline">
    {label}
  </Link>
);

// The original run and the fork side by side: the answers, the steps that changed, the cost and time.
export const ForkCompareScreen = () => {
  const { id = "" } = useParams();
  const { data, isLoading, error, refetch } = useComparison(id);
  const [showAll, setShowAll] = useState(false);

  const back = (
    <Link to={`/runs/${id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink">
      <ArrowLeft className="h-4 w-4" aria-hidden /> Back to the fork
    </Link>
  );
  if (isLoading) return <>{back}<DisplayLoading label="Loading the comparison" /></>;
  if (error || !data) {
    return (
      <>
        {back}
        <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />
      </>
    );
  }

  const { original, fork, rows, undoLinks } = data;
  const changedRows = rows.filter((row) => row.changed);
  const sameRows = rows.filter((row) => !row.changed);
  const finalIndex = answerIndex(rows);
  const finalRow = rows.find((row) => row.index === finalIndex);

  return (
    <>
      {back}
      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight">Original and fork, side by side</h1>
          <p className="mt-1 text-ink-soft">
            <RunLine run={original} label={original.name} /> is what the app really did. <RunLine run={fork} label="The fork" /> is the same run with your change. Words that differ are marked.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1">
          {/* Saving a run as a test arrives in the next milestone. */}
          <DisplayButton disabled aria-disabled="true">
            Save as test
          </DisplayButton>
          <span className="text-xs text-ink-faint">Coming soon</span>
        </div>
      </header>

      <p className="mb-2 flex items-start gap-2 rounded-lg border border-done/30 bg-done-tint px-4 py-3 text-sm text-done" role="note">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          <strong>Tools are simulated in a fork. Nothing real happens.</strong> Only the AI steps were asked again.
        </span>
      </p>
      <p className="mb-5 rounded-lg border border-line bg-sheet px-4 py-3 text-sm text-ink-soft" role="note">
        AI answers can vary. Asking the AI the same thing twice may give different words, so a difference does not always come from your change.
      </p>

      <section aria-label="Cost and time" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Cost" hint="What the AI calls cost. A dash means no cost was recorded." original={formatCost(original.costUsd)} fork={formatCost(fork.costUsd)} delta={change(original.costUsd, fork.costUsd)} />
        <Stat label="Time taken" original={formatDuration(original.durationMs)} fork={formatDuration(fork.durationMs)} delta={change(original.durationMs, fork.durationMs)} />
        <Stat
          label="Tokens"
          hint="Tokens are the pieces of text an AI model reads and writes."
          original={formatTokens(original.totalTokens)}
          fork={formatTokens(fork.totalTokens)}
          delta={change(original.totalTokens, fork.totalTokens)}
        />
        <Stat label="Steps" original={String(original.stepCount)} fork={String(fork.stepCount)} />
      </section>
      <p className="mt-2 text-xs text-ink-faint">Time for tools and lookups in a fork is what the original recorded, because they were not run again. A dash for cost means none was recorded (the free demo AI has no price).</p>

      {finalRow && finalIndex !== null && (
        <section className="mt-6 rounded-lg border border-line bg-sheet p-5" aria-labelledby="answer-title">
          <h2 id="answer-title" className="text-lg font-semibold">
            The answer
          </h2>
          <p className="mb-3 text-sm text-ink-soft">
            From step {finalIndex + 1}, {finalRow.name || "untitled"}.
          </p>
          <StepTexts original={original.id} fork={fork.id} index={finalIndex} part="output" />
        </section>
      )}

      <section className="mt-6" aria-labelledby="changes-title">
        <h2 id="changes-title" className="text-lg font-semibold">
          What changed, step by step
        </h2>
        {changedRows.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-line bg-sheet px-4 py-6 text-center text-ink-soft">
            Nothing changed in any step. The AI gave the same answers this time.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {changedRows.map((row) => (
              <ChangedRow key={row.index} row={row} originalId={original.id} forkId={fork.id} answerShownAbove={row.index === finalIndex} />
            ))}
          </ul>
        )}

        {sameRows.length > 0 && (
          <div className="mt-4">
            <button type="button" onClick={() => setShowAll(!showAll)} className="text-sm font-semibold text-brand underline" aria-expanded={showAll}>
              {showAll ? "Hide the steps that did not change" : `Show the ${sameRows.length} ${sameRows.length === 1 ? "step" : "steps"} that did not change`}
            </button>
            {showAll && (
              <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-sheet">
                {sameRows.map((row) => (
                  <li key={row.index} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <span className="min-w-0 truncate">
                      {row.index + 1}. {row.name || "Untitled step"}
                    </span>
                    <span className="text-ink-soft">{row.origin ? STEP_ORIGIN_META[row.origin]?.label : "Same"}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {undoLinks.length > 0 && <UndoList links={undoLinks} />}
    </>
  );
};
