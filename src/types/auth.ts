export type UserRole = "super_admin" | "admin" | "creator";

export type UserStatus = "enabled" | "disabled";

export interface AuthUser {
  id: number;
  name: string;
  role: UserRole;
}

export function normalizeRole(role: unknown, fallback: UserRole = "creator"): UserRole {
  return role === "super_admin" || role === "admin" || role === "creator" ? role : fallback;
}

export function normalizeStatus(status: unknown): UserStatus {
  return status === "disabled" ? "disabled" : "enabled";
}
