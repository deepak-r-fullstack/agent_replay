import { apiClient } from "./apiClient";
import { ApiEnvelope, AppSummary, AppWithKey, Check, CreateTestInput, ForkInput, SuiteRun, TestSummary, TestsPage, RunComparison, RunDetail, RunFilters, RunSummary, RunsPage, SessionUser, SignupInput, StepDetail } from "utils/types";

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

export const runService = {
  // Filters left empty are not sent at all.
  list: (filters: RunFilters, page: number) =>
    unwrap<RunsPage>(apiClient.get("/runs", { params: { ...filters, page } })),
  get: (id: string) => unwrap<RunDetail>(apiClient.get(`/runs/${id}`)),
  step: (id: string, index: number) => unwrap<StepDetail>(apiClient.get(`/runs/${id}/steps/${index}`)),
  // A fork asks the AI model, and the server gives it up to 90 seconds, so this waits a little longer than that.
  fork: (id: string, input: ForkInput) => unwrap<{ run: RunSummary }>(apiClient.post(`/runs/${id}/fork`, input, { timeout: 100_000 })),
  compare: (forkId: string) => unwrap<RunComparison>(apiClient.get(`/runs/${forkId}/compare`)),
};

export const testService = {
  list: () => unwrap<TestsPage>(apiClient.get("/tests")),
  create: (input: CreateTestInput) => unwrap<{ test: TestSummary }>(apiClient.post("/tests", input)),
  update: (id: string, changes: { name?: string; checks?: Check[] }) => unwrap<{ test: TestSummary }>(apiClient.put(`/tests/${id}`, changes)),
  remove: (id: string) => unwrap<null>(apiClient.delete(`/tests/${id}`)),
  // Asks the AI once per test, and the server gives the whole run up to 90 seconds, so this waits a little longer than that.
  runAll: (model?: string) => unwrap<SuiteRun>(apiClient.post("/tests/run", model ? { model } : {}, { timeout: 100_000 })),
};
