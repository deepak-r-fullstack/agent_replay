import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, KeyRound, Search, X } from "lucide-react";
import { DisplayButton, DisplayEmptyState, DisplayError, DisplayLoading, DisplayPageHeader, DisplayStatusBadge, DisplayTip } from "components/display_components";
import { useApps, useRuns } from "utils/hooks/useAgentReplayQueries";
import { useDebouncedValue } from "utils/hooks/useDebouncedValue";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { formatCost, formatDuration, plural, timeAgo } from "utils/helper_functions/format";
import { DisplayStatus, RunFilters, RunSummary } from "utils/types";

const STATUS_OPTIONS: Array<{ value: DisplayStatus | ""; label: string }> = [
  { value: "", label: "Any status" },
  { value: "ok", label: "Done" },
  { value: "failed", label: "Failed" },
  { value: "running", label: "Still running" },
  { value: "unfinished", label: "Unfinished" },
];

// The same grid for the header and every row, so the columns line up on wide screens.
const ROW_GRID = "md:grid md:grid-cols-[minmax(0,2.4fr)_100px_minmax(0,1.2fr)_64px_84px_84px_96px] md:items-center md:gap-x-4";

const RunRow = ({ run, backTo }: { run: RunSummary; backTo: string }) => {
  const who = [run.userRef && `for ${run.userRef}`, run.appName].filter(Boolean).join(" · ");
  return (
    <li>
      <Link to={`/runs/${run.id}`} state={{ backTo }} className={`block px-4 py-3 transition-colors hover:bg-brand-tint/40 ${ROW_GRID}`}>
        <span className="block min-w-0">
          <span className="block truncate font-medium">{run.name}</span>
          {who && <span className="block truncate text-sm text-ink-soft">{who}</span>}
        </span>
        <span className="mt-1 block md:mt-0">
          <DisplayStatusBadge status={run.displayStatus} />
        </span>
        {/* Phones get one short line; wide screens get a column each. */}
        <span className="mt-1 block text-sm text-ink-soft md:hidden">
          {[run.model, plural(run.stepCount, "step"), formatCost(run.costUsd), formatDuration(run.durationMs), timeAgo(run.startedAt)].filter((part) => part && part !== "—").join(" · ")}
        </span>
        <span className="hidden truncate text-sm text-ink-soft md:block">{run.model || "—"}</span>
        <span className="hidden text-sm md:block">{run.stepCount}</span>
        <span className="hidden text-sm md:block">{formatCost(run.costUsd)}</span>
        <span className="hidden text-sm md:block">{formatDuration(run.durationMs)}</span>
        <span className="hidden text-sm text-ink-soft md:block">{timeAgo(run.startedAt)}</span>
      </Link>
    </li>
  );
};

// Every run your apps have recorded. The filters and page are kept in the address, so "back" from a run returns here as you left it.
export const RunsScreen = () => {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const filters: RunFilters = {
    q: params.get("q") || undefined,
    status: (params.get("status") as DisplayStatus | null) || undefined,
    appId: params.get("appId") || undefined,
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
  };
  const page = Math.max(1, Number(params.get("page")) || 1);
  const hasFilters = Object.values(filters).some(Boolean);

  // The search box types freely; the address (and so the list) only follows once typing pauses.
  const [search, setSearch] = useState(filters.q || "");
  const debouncedSearch = useDebouncedValue(search, 300);

  const change = (changes: Partial<Record<keyof RunFilters | "page", string>>) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
    if (!("page" in changes)) next.delete("page"); // a different filter starts again from page 1
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if (debouncedSearch.trim() !== (filters.q || "")) change({ q: debouncedSearch.trim() });
    // Only a pause in typing should change the address.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const clearFilters = () => {
    setSearch("");
    setParams(new URLSearchParams(), { replace: true });
  };

  const { data, isLoading, error, refetch } = useRuns(filters, page);
  const { data: apps } = useApps();
  const backTo = `/runs${location.search}`;
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const firstShown = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const lastShown = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  return (
    <>
      <DisplayPageHeader
        title="Runs"
        description={
          <>
            Every time your app's AI does a job, it shows up here. Open one to see each step it took. A run that stops reporting for an hour shows as{" "}
            <DisplayTip term="Unfinished" meaning="This run never reported that it finished. The app may have stopped." />.
          </>
        }
      />

      <section className="mb-4 grid grid-cols-2 gap-3 rounded-lg border border-line bg-sheet p-4 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr_1fr]" aria-label="Filters">
        <div className="col-span-2 lg:col-span-1">
          <label htmlFor="runSearch" className="field-label">
            Search
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" aria-hidden />
            <input
              id="runSearch"
              type="search"
              className="field-input pl-9"
              placeholder="Run name or customer"
              value={search}
              maxLength={80}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        <div>
          <label htmlFor="runStatus" className="field-label">
            Status
          </label>
          <select id="runStatus" className="field-input" value={filters.status || ""} onChange={(event) => change({ status: event.target.value })}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="runApp" className="field-label">
            App
          </label>
          <select id="runApp" className="field-input" value={filters.appId || ""} onChange={(event) => change({ appId: event.target.value })}>
            <option value="">All apps</option>
            {apps?.map((app) => (
              <option key={app.id} value={app.id}>
                {app.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="runFrom" className="field-label">
            From
          </label>
          <input id="runFrom" type="date" className="field-input" value={filters.from || ""} max={filters.to || undefined} onChange={(event) => change({ from: event.target.value })} />
        </div>
        <div>
          <label htmlFor="runTo" className="field-label">
            To
          </label>
          <input id="runTo" type="date" className="field-input" value={filters.to || ""} min={filters.from || undefined} onChange={(event) => change({ to: event.target.value })} />
        </div>
      </section>

      {isLoading && <DisplayLoading label="Loading runs" />}
      {error && <DisplayError message={getErrorMessage(error)} onRetry={() => refetch()} />}

      {data && data.total === 0 && !hasFilters && (
        <DisplayEmptyState
          title="No runs yet"
          description="Runs appear here as soon as your app records them with the AgentReplay SDK. Add an app to get a key, paste it into your code, and run your app once."
          action={
            <Link to="/apps">
              <DisplayButton variant="primary" icon={<KeyRound className="h-4 w-4" aria-hidden />}>
                Set up an app
              </DisplayButton>
            </Link>
          }
        />
      )}

      {data && data.total === 0 && hasFilters && (
        <DisplayEmptyState
          title="No runs match these filters"
          description="Try a different word, or widen the dates."
          action={
            <DisplayButton onClick={clearFilters} icon={<X className="h-4 w-4" aria-hidden />}>
              Clear filters
            </DisplayButton>
          }
        />
      )}

      {data && data.total > 0 && data.runs.length === 0 && (
        <DisplayEmptyState
          title="There is nothing on this page"
          description="Some runs may have been removed since you last looked."
          action={<DisplayButton onClick={() => change({ page: "" })}>Go to the first page</DisplayButton>}
        />
      )}

      {data && data.runs.length > 0 && (
        <>
          <div className="overflow-hidden rounded-lg border border-line bg-sheet">
            <div className={`hidden border-b border-line bg-paper px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-faint ${ROW_GRID}`} aria-hidden>
              <span>Run</span>
              <span>Status</span>
              <span>AI model</span>
              <span>Steps</span>
              <span title="What the AI calls in this run cost. A dash means no cost was recorded.">Cost</span>
              <span>Time taken</span>
              <span>Started</span>
            </div>
            <ul className="divide-y divide-line">
              {data.runs.map((run) => (
                <RunRow key={run.id} run={run} backTo={backTo} />
              ))}
            </ul>
          </div>

          <nav className="mt-4 flex flex-wrap items-center justify-between gap-3" aria-label="Pages">
            <p className="text-sm text-ink-soft">
              Showing {firstShown}–{lastShown} of {plural(data.total, "run")}
            </p>
            <div className="flex items-center gap-2">
              <DisplayButton disabled={page <= 1} onClick={() => change({ page: String(page - 1) })} icon={<ChevronLeft className="h-4 w-4" aria-hidden />}>
                Newer
              </DisplayButton>
              <span className="text-sm text-ink-soft">
                Page {page} of {lastPage}
              </span>
              <DisplayButton disabled={page >= lastPage} onClick={() => change({ page: String(page + 1) })}>
                Older
                <ChevronRight className="h-4 w-4" aria-hidden />
              </DisplayButton>
            </div>
          </nav>
        </>
      )}
    </>
  );
};
