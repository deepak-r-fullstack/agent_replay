import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appService } from "utils/services/api_services/agentreplay_service";
import { getErrorMessage } from "utils/services/api_services/apiClient";
import { showToast } from "utils/store/toastStore";

// React Query hooks, one per screen need. Mutations refresh every list they can change,
// so screens never show stale state after a key is created or revoked.

export const queryKeys = {
  apps: ["apps"] as const,
};

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
