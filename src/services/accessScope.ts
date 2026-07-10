import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import type { AccessibleProject } from "@/types/access";
import u from "@/utils";

export type ResourceKind =
  | "project"
  | "novel"
  | "event"
  | "script"
  | "storyboard"
  | "asset"
  | "image"
  | "imageFlow"
  | "video"
  | "task"
  | "track"
  | "agentWork";

export class AccessScopeError extends Error {
  readonly status = 404;
}

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

export async function getProjectIdForResource(resource: ResourceKind, resourceId: number): Promise<number | null> {
  if (resource === "project") {
    const project = await u.db("o_project").where("id", resourceId).select("id").first();
    return project?.id == null ? null : Number(project.id);
  }
  const directTables: Partial<Record<ResourceKind, string>> = {
    novel: "o_novel",
    script: "o_script",
    storyboard: "o_storyboard",
    asset: "o_assets",
    video: "o_video",
    task: "o_tasks",
    track: "o_videoTrack",
    imageFlow: "o_imageFlow",
    agentWork: "o_agentWorkData",
  };
  if (resource === "event") {
    const rows = await u
      .db("o_eventChapter")
      .leftJoin("o_novel", "o_novel.id", "o_eventChapter.novelId")
      .where("o_eventChapter.eventId", resourceId)
      .whereNotNull("o_novel.projectId")
      .distinct("o_novel.projectId");
    return rows.length === 1 && rows[0].projectId != null ? Number(rows[0].projectId) : null;
  }
  if (resource === "image") {
    const row = await u
      .db("o_image")
      .leftJoin("o_assets", "o_assets.id", "o_image.assetsId")
      .where("o_image.id", resourceId)
      .select("o_assets.projectId")
      .first();
    return row?.projectId == null ? null : Number(row.projectId);
  }
  const table = directTables[resource];
  if (!table) return null;
  const row = await u.db(table as any).where("id", resourceId).select("projectId").first();
  return row?.projectId == null ? null : Number(row.projectId);
}

export async function assertResourceAccess(actor: AuthUser, resource: ResourceKind, resourceId: number): Promise<number> {
  const projectId = await getProjectIdForResource(resource, resourceId);
  if (projectId === null || !(await getAccessibleProject(actor, projectId))) {
    throw new AccessScopeError("资源不存在或当前账号无权访问");
  }
  return projectId;
}
