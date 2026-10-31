import { UserRole } from "utils/types";

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

// Words people see for each role. Kept in one place so every screen says the same thing.
export const ROLE_LABEL: Record<UserRole, string> = { owner: "Owner", developer: "Developer", viewer: "Viewer" };
