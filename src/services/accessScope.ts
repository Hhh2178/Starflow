import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import type { AccessibleProject } from "@/types/access";
import u from "@/utils";

export function applyProjectScope(query: Knex.QueryBuilder, actor: AuthUser): Knex.QueryBuilder {
  if (actor.role === "super_admin") return query;
  if (actor.role === "admin") return query.where("o_project.groupId", actor.groupId);
  return query.where("o_project.ownerUserId", actor.id);
}

export async function getAccessibleProject(actor: AuthUser, projectId: number): Promise<AccessibleProject | undefined> {
  const query = u.db("o_project").where("o_project.id", projectId);
  const project = await applyProjectScope(query, actor).first();
  if (!project) return undefined;
  return {
    ...project,
    id: Number(project.id),
    ownerUserId: project.ownerUserId == null ? null : Number(project.ownerUserId),
    groupId: project.groupId == null ? null : Number(project.groupId),
  };
}
