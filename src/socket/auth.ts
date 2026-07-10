import jwt from "jsonwebtoken";
import u from "@/utils";
import { normalizeRole, AuthUser } from "@/types/auth";
import { getAccessibleProject } from "@/services/accessScope";

export async function authenticateSocketProject(rawToken: string, projectId: number, scriptId?: number): Promise<AuthUser | null> {
  if (!rawToken || !Number.isFinite(Number(projectId))) return null;
  const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
  if (!setting?.value) return null;

  let decoded: any;
  try {
    decoded = jwt.verify(rawToken.replace("Bearer ", ""), String(setting.value));
  } catch {
    return null;
  }

  const row = await u.db("o_user").where("id", Number(decoded?.id)).select("id", "name", "role", "status", "groupId").first();
  if (!row || row.status !== "enabled") return null;
  const role = normalizeRole(row.role, Number(row.id) === 1 ? "super_admin" : "creator");
  const groupId = row.groupId == null ? null : Number(row.groupId);
  if (role !== "super_admin" && groupId === null) return null;

  const actor: AuthUser = { id: Number(row.id), name: String(row.name), role, groupId };
  if (!(await getAccessibleProject(actor, Number(projectId)))) return null;
  if (scriptId !== undefined) {
    const script = await u.db("o_script").where("id", Number(scriptId)).select("projectId").first();
    if (script?.projectId == null || Number(script.projectId) !== Number(projectId)) return null;
  }
  return actor;
}

export function isSocketIsolationKeyValid(projectId: number, isolationKey: unknown): isolationKey is string {
  return typeof isolationKey === "string" && isolationKey.startsWith(`${projectId}:`);
}
