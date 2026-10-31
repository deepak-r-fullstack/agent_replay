// Shapes returned by the AgentReplay API (see server controllers).

export type UserRole = "owner" | "developer" | "viewer";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  workspaceId: string;
  workspaceName: string;
}

export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

export interface AppSummary {
  id: string;
  name: string;
  apiKeyPreview: string;
  active: boolean;
  createdAt: string;
}

// Only create and rotate return the full key, and only once.
export interface AppWithKey extends AppSummary {
  apiKey: string;
}

export interface SignupInput {
  name: string;
  workspaceName: string;
  email: string;
  password: string;
}
