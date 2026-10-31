import { useState } from "react";
import { Link } from "react-router-dom";
import { FlaskConical, Play } from "lucide-react";
import { DisplayBadge, DisplayButton, DisplayEmptyState, DisplayError, DisplayLoading, DisplayPageHeader, DisplayTip } from "components/display_components";
import { useDeleteTest, useRunAllTests, useTests, useUpdateTest } from "utils/hooks/useAgentReplayQueries";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { CHANGE_META, describeCheck, formatCost, formatDuration, OUTCOME_META, plural, timeAgo } from "utils/helper_functions/format";
import { useAuthStore } from "utils/store/authStore";
import { SuiteSummary, TestSummary } from "utils/types";
import { CheckEditor, checksToDrafts, CheckDraft, draftsToChecks } from "./CheckEditor";

const SummaryCount = ({ count, label, tone }: { count: number; label: string; tone: "done" | "refused" | "neutral" | "waiting" }) => {
  const styles = { done: "bg-done-tint text-done", refused: "bg-refused-tint text-refused", neutral: "bg-ink/5 text-ink-soft", waiting: "bg-waiting-tint text-waiting" };
  return (
    <div className={`rounded-lg px-4 py-3 ${styles[tone]}`}>
      <p className="text-2xl font-semibold">{count}</p>
      <p className="text-sm">{label}</p>
    </div>
  );
};

// What got better and what got worse in the last run of all tests.
const SuiteCard = ({ suite, tests }: { suite: SuiteSummary; tests: TestSummary[] }) => {
  const inThisRun = tests.filter((test) => test.lastResult?.suiteRunId === suite.id);
  const worse = inThisRun.filter((test) => test.lastResult?.change === "worse");
  const better = inThisRun.filter((test) => test.lastResult?.change === "improved");
  return (
    <section className="mb-6 rounded-lg border border-line bg-sheet p-5" aria-labelledby="suite-title">
      <h2 id="suite-title" className="text-lg font-semibold">
        Last time you ran all tests
      </h2>
      <p className="mt-0.5 text-sm text-ink-soft">
        {timeAgo(suite.ranAt)}, with the model <strong>{suite.model || "the usual one"}</strong>. Each test is compared with the last time it was run.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCount count={suite.improved} label="Got better" tone="done" />
        <SummaryCount count={suite.same} label="Stayed the same" tone="neutral" />
        <SummaryCount count={suite.worse} label="Got worse" tone="refused" />
        <SummaryCount count={suite.notRun + suite.new} label={suite.notRun > 0 ? "New or could not run" : "First time"} tone="waiting" />
      </div>
      {worse.length > 0 && (
        <div className="mt-4" role="status">
          <h3 className="text-sm font-semibold text-refused">What got worse</h3>
          <ul className="mt-1 flex flex-col gap-2">
            {worse.map((test) => (
              <li key={test.id} className="rounded-md border border-refused/30 bg-refused-tint px-3 py-2 text-sm text-refused">
                <span className="font-semibold">{test.name}</span> used to pass and now fails.
                {test.lastResult?.failedChecks.map((item) => (
                  <span key={item.message} className="block">
                    {item.message}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      {better.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-done">What got better</h3>
          <ul className="mt-1 flex flex-col gap-2">
            {better.map((test) => (
              <li key={test.id} className="rounded-md border border-done/30 bg-done-tint px-3 py-2 text-sm text-done">
                <span className="font-semibold">{test.name}</span> used to fail and now passes.
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

const TestCard = ({ test, canEdit }: { test: TestSummary; canEdit: boolean }) => {
  const update = useUpdateTest();
  const remove = useDeleteTest();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(test.name);
  const [drafts, setDrafts] = useState<CheckDraft[]>([]);
  const [problem, setProblem] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const result = test.lastResult;

  const startEditing = () => {
    setName(test.name);
    setDrafts(checksToDrafts(test.checks));
    setProblem("");
    setEditing(true);
  };

  const save = () => {
    const { checks, problem: found } = draftsToChecks(drafts);
    if (!name.trim()) return setProblem("Please give the test a name.");
    if (found) return setProblem(found);
    setProblem("");
    update.mutate({ id: test.id, name: name.trim(), checks }, { onSuccess: () => setEditing(false) });
  };

  return (
    <li className="rounded-lg border border-line bg-sheet p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-lg font-semibold">{test.name}</h3>
          <p className="mt-0.5 text-sm text-ink-soft">
            From the run{" "}
            <Link to={`/runs/${test.sourceRunId}`} className="font-medium text-brand underline">
              step {test.sourceStepIndex + 1}
            </Link>
            {test.model && <> · asked of {test.model}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {result ? (
            <>
              <DisplayBadge label={OUTCOME_META[result.outcome].label} tone={OUTCOME_META[result.outcome].tone} />
              {(result.change === "improved" || result.change === "worse") && <DisplayBadge label={CHANGE_META[result.change].label} tone={CHANGE_META[result.change].tone} />}
            </>
          ) : (
            <DisplayBadge label="Not run yet" />
          )}
        </div>
      </div>

      <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words rounded-md border border-line bg-paper px-3 py-2 text-sm">{test.prompt}</p>

      {editing ? (
        <div className="mt-4">
          <label htmlFor={`name-${test.id}`} className="field-label">
            Name of the test
          </label>
          <input id={`name-${test.id}`} className="field-input" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
          <h4 className="mt-4 text-sm font-semibold">What a good answer looks like</h4>
          <p className="mb-2 text-xs text-ink-faint">Changing the checks clears the last result, because it was judged by the old checks.</p>
          <CheckEditor drafts={drafts} onChange={setDrafts} idPrefix={`edit-${test.id}`} />
          {problem && (
            <div className="mt-3">
              <DisplayError message={problem} />
            </div>
          )}
          {update.error && (
            <div className="mt-3">
              <DisplayError message={getErrorMessage(update.error)} />
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <DisplayButton variant="primary" loading={update.isPending} onClick={save}>
              Save changes
            </DisplayButton>
            <DisplayButton onClick={() => setEditing(false)} disabled={update.isPending}>
              Cancel
            </DisplayButton>
          </div>
        </div>
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {test.checks.map((check, position) => (
              <li key={position} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" aria-hidden />
                <span>{describeCheck(check)}</span>
              </li>
            ))}
          </ul>

          {result && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-sm text-ink-soft">
                Last run {timeAgo(result.ranAt)}
                {result.model && <> with {result.model}</>}
                {result.outcome !== "skipped" && result.outcome !== "error" && (
                  <>
                    {" "}
                    · {formatDuration(result.durationMs)} · cost {formatCost(result.costUsd)}
                  </>
                )}
              </p>
              {result.note && <p className="mt-2 rounded-md border border-waiting/30 bg-waiting-tint px-3 py-2 text-sm text-waiting">{result.note}</p>}
              {result.error && <p className="mt-2 rounded-md border border-waiting/30 bg-waiting-tint px-3 py-2 text-sm text-waiting">{result.error}</p>}
              {result.failedChecks.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {result.failedChecks.map((item) => (
                    <li key={item.message} className="rounded-md border border-refused/30 bg-refused-tint px-3 py-2 text-sm text-refused">
                      {item.message}
                    </li>
                  ))}
                </ul>
              )}
              {result.output && (
                <div className="mt-2">
                  <button type="button" onClick={() => setShowAnswer(!showAnswer)} className="text-sm font-semibold text-brand underline" aria-expanded={showAnswer}>
                    {showAnswer ? "Hide the answer" : "Show the answer it gave"}
                  </button>
                  {showAnswer && <p className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-paper px-3 py-2 text-sm">{result.output}</p>}
                </div>
              )}
            </div>
          )}

          {canEdit && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <DisplayButton onClick={startEditing}>Edit checks</DisplayButton>
              {confirmingDelete ? (
                <span className="flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm deleting ${test.name}`}>
                  <span className="text-sm text-ink-soft">Delete this test and its results?</span>
                  <DisplayButton variant="danger" loading={remove.isPending} onClick={() => remove.mutate(test.id)}>
                    Yes, delete it
                  </DisplayButton>
                  <DisplayButton variant="ghost" onClick={() => setConfirmingDelete(false)}>
                    Cancel
                  </DisplayButton>
                </span>
              ) : (
                <DisplayButton variant="ghost" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </DisplayButton>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
};

// Saved tests, and one button that asks the AI all of them again and says what got better or worse.
export const TestsScreen = () => {
  const { data, isLoading, error, refetch } = useTests();
  const runAll = useRunAllTests();
  const role = useAuthStore((state) => state.user?.role);
  const canEdit = role === "owner" || role === "developer";
  const [model, setModel] = useState("");

  return (
    <>
      <DisplayPageHeader
        title="Tests"
        description={
          <>
            A test remembers a question you asked an AI and what a good answer must look like. Run all your tests after you change a model or a prompt, to see what got better and what got worse. Saving a test starts from any AI step in{" "}
            <Link to="/runs" className="font-medium text-brand underline">
              a run
            </Link>
            .
          </>
        }
      />

      {isLoading && <DisplayLoading label="Loading your tests" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}

      {data && data.tests.length === 0 && (
        <DisplayEmptyState
          title="No tests yet"
          description="Open a run, pick an AI step and choose Save as test. After that you can check, any time, that the AI still answers well."
          action={
            <Link to="/runs">
              <DisplayButton variant="primary" icon={<FlaskConical className="h-4 w-4" aria-hidden />}>
                Go to my runs
              </DisplayButton>
            </Link>
          }
        />
      )}

      {data && data.tests.length > 0 && (
        <>
          <section className="mb-6 flex flex-wrap items-end justify-between gap-4 rounded-lg border border-line bg-sheet p-4" aria-label="Run all tests">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink-soft">
                You have {plural(data.tests.length, "test")} (up to {data.limits.maxTests}). Running them asks the AI once for each test. Results are compared with the{" "}
                <DisplayTip term="last time" meaning="Each test is compared with the last time its checks were really made. A test that could not run does not count." /> each test was run.
              </p>
            </div>
            {canEdit ? (
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="suiteModel" className="field-label">
                    AI model
                  </label>
                  <select id="suiteModel" className="field-input" value={model} onChange={(event) => setModel(event.target.value)} disabled={runAll.isPending}>
                    <option value="">Each test's own ({data.defaultModel} if none)</option>
                    {data.modelChoices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                </div>
                <DisplayButton variant="primary" size="lg" loading={runAll.isPending} onClick={() => runAll.mutate(model || undefined)} icon={<Play className="h-4 w-4" aria-hidden />}>
                  {runAll.isPending ? "Asking the AI" : "Run all tests"}
                </DisplayButton>
              </div>
            ) : (
              <p className="text-sm text-ink-faint">Only an owner or developer can run tests.</p>
            )}
          </section>
          {runAll.isPending && (
            <p className="mb-4 text-sm text-ink-soft" role="status">
              Asking the AI. With a real model this can take up to a minute and a half; nothing is lost if you wait.
            </p>
          )}
          {runAll.error && (
            <div className="mb-4">
              <DisplayError message={getErrorMessage(runAll.error)} />
            </div>
          )}

          {data.latestSuite && <SuiteCard suite={data.latestSuite} tests={data.tests} />}

          <ul className="flex flex-col gap-4">
            {data.tests.map((test) => (
              <TestCard key={test.id} test={test} canEdit={canEdit} />
            ))}
          </ul>
        </>
      )}
    </>
  );
};
