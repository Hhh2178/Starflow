import { AuthUser, normalizeRole, normalizeStatus, UserRole, UserStatus } from "@/types/auth";

export interface SafeUser {
  id: number;
  name: string;
  role: UserRole;
  status: UserStatus;
  groupId: number | null;
  mustChangePassword: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  lastLoginAt: number | null;
}

export const SAFE_USER_COLUMNS = [
  "id",
  "name",
  "role",
  "status",
  "groupId",
  "mustChangePassword",
  "createdAt",
  "updatedAt",
  "lastLoginAt",
] as const;

export function toSafeUser(user: any): SafeUser {
  return {
    id: Number(user.id),
    name: String(user.name || ""),
    role: normalizeRole(user.role, Number(user.id) === 1 ? "super_admin" : "creator"),
    status: normalizeStatus(user.status),
    groupId: user.groupId == null ? null : Number(user.groupId),
    mustChangePassword: Boolean(user.mustChangePassword),
    createdAt: user.createdAt == null ? null : Number(user.createdAt),
    updatedAt: user.updatedAt == null ? null : Number(user.updatedAt),
    lastLoginAt: user.lastLoginAt == null ? null : Number(user.lastLoginAt),
  };
}

export function canAssignRole(actor: AuthUser, role: UserRole): boolean {
  return actor.role === "super_admin" || (actor.role === "admin" && role === "creator");
}

export function canManageUser(actor: AuthUser, target: SafeUser): boolean {
  return (
    actor.role === "super_admin" ||
    (actor.role === "admin" && target.role === "creator" && actor.groupId !== null && target.groupId === actor.groupId)
  );
}
