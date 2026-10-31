import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appService, runService } from "utils/services/api_services/agentreplay_service";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { showToast } from "utils/store/toastStore";
import { ForkInput, RunFilters } from "utils/types";

// React Query hooks, one per screen need. Mutations refresh every list they can change,
// so screens never show stale state after a key is created or revoked.

export const queryKeys = {
  apps: ["apps"] as const,
  runs: (filters: RunFilters, page: number) => ["runs", filters, page] as const,
  run: (id: string) => ["run", id] as const,
  step: (id: string, index: number) => ["step", id, index] as const,
  comparison: (id: string) => ["comparison", id] as const,
};

// Runs arrive from apps at any time, so what is on screen refreshes itself.
const LIVE_REFRESH_MS = 5000;

export function useApps() {
  return useQuery({ queryKey: queryKeys.apps, queryFn: () => appService.list().then((response) => response.data) });
}

export function useCreateApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => appService.create(name).then((response) => response.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps }),
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function useRotateKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => appService.rotateKey(id).then((response) => response.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apps }),
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

export function useRevokeKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => appService.revokeKey(id).then((response) => response.data),
    onSuccess: (app) => {
      showToast(`The key for ${app.name} has been switched off.`);
      queryClient.invalidateQueries({ queryKey: queryKeys.apps });
    },
    onError: (error) => showToast(getErrorMessage(error), "error"),
  });
}

// ---------- runs and replay ----------

export function useRuns(filters: RunFilters, page: number) {
  return useQuery({
    queryKey: queryKeys.runs(filters, page),
    queryFn: () => runService.list(filters, page).then((response) => response.data),
    refetchInterval: LIVE_REFRESH_MS,
    // Keep showing the old list while the next one loads, so the table does not flash empty on every keystroke.
    placeholderData: keepPreviousData,
  });
}

export function useRun(id: string) {
  return useQuery({
    queryKey: queryKeys.run(id),
    queryFn: () => runService.get(id).then((response) => response.data),
    // Only a run that is still going needs to keep refreshing.
    refetchInterval: (query) => (query.state.data?.run.displayStatus === "running" ? LIVE_REFRESH_MS : false),
  });
}

// Steps never change once saved, so each one is fetched once.
export function useStepDetail(id: string, index: number | null) {
  return useQuery({
    queryKey: queryKeys.step(id, index ?? -1),
    queryFn: () => runService.step(id, index as number).then((response) => response.data),
    enabled: index !== null,
    staleTime: Infinity,
  });
}

// ---------- forks ----------

// Asks the AI model, so it can take a few seconds. The new fork is a new run, so the runs list is refreshed.
export function useForkRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ForkInput) => runService.fork(runId, input).then((response) => response.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runs"] }),
  });
}

// A fork and its original never change after the fork is made, so the comparison is fetched once.
export function useComparison(forkId: string) {
  return useQuery({
    queryKey: queryKeys.comparison(forkId),
    queryFn: () => runService.compare(forkId).then((response) => response.data),
    staleTime: Infinity,
  });
}
