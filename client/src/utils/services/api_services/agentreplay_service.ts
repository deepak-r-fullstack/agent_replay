import { apiClient } from "./apiClient";
import { ApiEnvelope, AppSummary, AppWithKey, SessionUser, SignupInput } from "utils/types";

// Thin wrappers around each endpoint. They return the full envelope; screens read `data` (and `message` when they want it).

async function unwrap<T>(request: Promise<{ data: ApiEnvelope<T> }>) {
  const response = await request;
  return response.data;
}

type Session = { token: string; user: SessionUser };

export const authService = {
  login: (email: string, password: string) => unwrap<Session>(apiClient.post("/auth/login", { email, password })),
  signup: (input: SignupInput) => unwrap<Session>(apiClient.post("/auth/signup", input)),
  demo: () => unwrap<Session>(apiClient.post("/auth/demo")),
};

export const appService = {
  list: () => unwrap<AppSummary[]>(apiClient.get("/apps")),
  create: (name: string) => unwrap<AppWithKey>(apiClient.post("/apps", { name })),
  rotateKey: (id: string) => unwrap<AppWithKey>(apiClient.post(`/apps/${id}/rotate-key`)),
  revokeKey: (id: string) => unwrap<AppSummary>(apiClient.post(`/apps/${id}/revoke-key`)),
};
