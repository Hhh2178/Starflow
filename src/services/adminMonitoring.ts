import type { Knex } from "knex";
import { normalizeMoney } from "@/lib/money";
import type { AuthUser } from "@/types/auth";

type MonitoringConnection = Knex | Knex.Transaction;

export interface AdminListInput {
  page?: number;
  pageSize?: number;
  groupId?: number;
  ownerUserId?: number;
  search?: string;
}

export interface AdminTaskListInput extends AdminListInput {
  projectId?: number;
  state?: string;
  taskClass?: string;
}

export interface AdminUsageInput extends AdminListInput {
  projectId?: number;
  taskType?: string;
  providerId?: string;
  modelId?: string;
}

export interface AdminProjectListItem {
  id: number; name: string; projectType: string | null; type: string | null;
  ownerUserId: number | null; ownerName: string | null; groupId: number; groupName: string;
  createTime: number | null; taskCount: number;
}

export interface AdminTaskListItem {
  id: number; projectId: number; projectName: string; ownerUserId: number | null; ownerName: string | null;
  groupId: number; groupName: string; taskClass: string | null; model: string | null;
  description: string | null; state: string | null; startTime: number | null; reason: string | null;
}

export interface AdminPagedResult<T> { page: number; pageSize: number; total: number; items: T[] }

export interface AdminUsageListItem {
  id: number; jobId: number; groupId: number; groupName: string; userId: number; userName: string;
  projectId: number | null; projectName: string | null; providerId: string | null; modelId: string | null;
  taskType: string; estimatedCost: number | null; currency: string | null; result: string; createdAt: number;
}

export interface AdminUsageOverview extends AdminPagedResult<AdminUsageListItem> {
  summary: { recordCount: number; estimatedCost: number };
  breakdown: Array<{ taskType: string; recordCount: number; estimatedCost: number }>;
}

export class AdminMonitoringError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

async function resolveConnection(connection?: MonitoringConnection): Promise<MonitoringConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

function assertAdmin(actor: AuthUser): void {
  if (actor.role === "creator") throw new AdminMonitoringError(403, "ADMIN_REQUIRED", "仅管理员可以查看运营数据");
  if (actor.role === "admin" && actor.groupId == null) {
    throw new AdminMonitoringError(403, "ADMIN_GROUP_REQUIRED", "管理员尚未归属分组");
  }
}

function resolveScopeGroup(actor: AuthUser, requestedGroupId?: number): number | undefined {
  assertAdmin(actor);
  if (requestedGroupId !== undefined && (!Number.isInteger(requestedGroupId) || requestedGroupId <= 0)) {
    throw new AdminMonitoringError(422, "GROUP_ID_INVALID", "分组 ID 必须是正整数");
  }
  if (actor.role === "admin") {
    if (requestedGroupId !== undefined && requestedGroupId !== actor.groupId) {
      throw new AdminMonitoringError(404, "SCOPE_NOT_FOUND", "请求的数据不存在");
    }
    return Number(actor.groupId);
  }
  return requestedGroupId;
}

function normalizePage(input: { page?: number; pageSize?: number }) {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1) throw new AdminMonitoringError(422, "PAGE_INVALID", "页码必须是正整数");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new AdminMonitoringError(422, "PAGE_SIZE_INVALID", "每页数量必须是 1 至 200 的整数");
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function assertOptionalId(value: number | undefined, code: string, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new AdminMonitoringError(422, code, `${label}必须是正整数`);
  }
}

export async function listAdminProjects(
  actor: AuthUser,
  input: AdminListInput = {},
  connection?: MonitoringConnection,
): Promise<AdminPagedResult<AdminProjectListItem>> {
  const scopedGroupId = resolveScopeGroup(actor, input.groupId);
  const { page, pageSize, offset } = normalizePage(input);
  assertOptionalId(input.ownerUserId, "OWNER_USER_ID_INVALID", "负责人 ID ");
  const db = await resolveConnection(connection);

  const applyFilters = (query: Knex.QueryBuilder) => {
    let filtered = query;
    if (scopedGroupId !== undefined) filtered = filtered.where("o_project.groupId", scopedGroupId);
    if (input.ownerUserId !== undefined) filtered = filtered.where("o_project.ownerUserId", input.ownerUserId);
    const search = input.search?.trim();
    if (search) filtered = filtered.where("o_project.name", "like", `%${search}%`);
    return filtered;
  };

  const countRow = await applyFilters(db("o_project")).count({ count: "o_project.id" }).first();
  const rows = await applyFilters(
    db("o_project")
      .leftJoin("o_user as owner", "owner.id", "o_project.ownerUserId")
      .leftJoin("o_group as projectGroup", "projectGroup.id", "o_project.groupId"),
  )
    .select(
      "o_project.id",
      "o_project.name",
      "o_project.projectType",
      "o_project.type",
      "o_project.ownerUserId",
      "owner.name as ownerName",
      "o_project.groupId",
      "projectGroup.name as groupName",
      "o_project.createTime",
    )
    .orderBy("o_project.createTime", "desc")
    .orderBy("o_project.id", "desc")
    .offset(offset)
    .limit(pageSize);
  const projectIds = rows.map((row: any) => Number(row.id));
  const taskCountRows = projectIds.length
    ? await db("o_tasks").whereIn("projectId", projectIds).select("projectId").count({ count: "id" }).groupBy("projectId")
    : [];
  const taskCounts = new Map(taskCountRows.map((row: any) => [Number(row.projectId), Number(row.count)]));

  return {
    page,
    pageSize,
    total: Number(countRow?.count ?? 0),
    items: rows.map((row: any): AdminProjectListItem => ({
      id: Number(row.id),
      name: String(row.name ?? ""),
      projectType: row.projectType == null ? null : String(row.projectType),
      type: row.type == null ? null : String(row.type),
      ownerUserId: row.ownerUserId == null ? null : Number(row.ownerUserId),
      ownerName: row.ownerName == null ? null : String(row.ownerName),
      groupId: Number(row.groupId),
      groupName: row.groupName == null ? `分组 #${row.groupId}` : String(row.groupName),
      createTime: row.createTime == null ? null : Number(row.createTime),
      taskCount: taskCounts.get(Number(row.id)) ?? 0,
    })),
  };
}

export async function listAdminTasks(
  actor: AuthUser,
  input: AdminTaskListInput = {},
  connection?: MonitoringConnection,
): Promise<AdminPagedResult<AdminTaskListItem>> {
  const scopedGroupId = resolveScopeGroup(actor, input.groupId);
  const { page, pageSize, offset } = normalizePage(input);
  assertOptionalId(input.ownerUserId, "OWNER_USER_ID_INVALID", "负责人 ID ");
  assertOptionalId(input.projectId, "PROJECT_ID_INVALID", "项目 ID ");
  const db = await resolveConnection(connection);

  const base = () => db("o_tasks").leftJoin("o_project", "o_project.id", "o_tasks.projectId");
  const applyFilters = (query: Knex.QueryBuilder) => {
    let filtered = query;
    if (scopedGroupId !== undefined) filtered = filtered.where("o_project.groupId", scopedGroupId);
    if (input.ownerUserId !== undefined) filtered = filtered.where("o_tasks.ownerUserId", input.ownerUserId);
    if (input.projectId !== undefined) filtered = filtered.where("o_tasks.projectId", input.projectId);
    if (input.state?.trim()) filtered = filtered.where("o_tasks.state", input.state.trim());
    if (input.taskClass?.trim()) filtered = filtered.where("o_tasks.taskClass", input.taskClass.trim());
    const search = input.search?.trim();
    if (search) filtered = filtered.where((builder) => builder.where("o_project.name", "like", `%${search}%`).orWhere("o_tasks.describe", "like", `%${search}%`));
    return filtered;
  };

  const countRow = await applyFilters(base()).count({ count: "o_tasks.id" }).first();
  const rows = await applyFilters(
    base()
      .leftJoin("o_user as taskOwner", "taskOwner.id", "o_tasks.ownerUserId")
      .leftJoin("o_group as taskGroup", "taskGroup.id", "o_project.groupId"),
  )
    .select(
      "o_tasks.id",
      "o_tasks.projectId",
      "o_project.name as projectName",
      "o_tasks.ownerUserId",
      "taskOwner.name as ownerName",
      "o_project.groupId",
      "taskGroup.name as groupName",
      "o_tasks.taskClass",
      "o_tasks.model",
      "o_tasks.describe",
      "o_tasks.state",
      "o_tasks.startTime",
      "o_tasks.reason",
    )
    .orderBy("o_tasks.startTime", "desc")
    .orderBy("o_tasks.id", "desc")
    .offset(offset)
    .limit(pageSize);

  return {
    page,
    pageSize,
    total: Number(countRow?.count ?? 0),
    items: rows.map((row: any): AdminTaskListItem => ({
      id: Number(row.id),
      projectId: Number(row.projectId),
      projectName: row.projectName == null ? `项目 #${row.projectId}` : String(row.projectName),
      ownerUserId: row.ownerUserId == null ? null : Number(row.ownerUserId),
      ownerName: row.ownerName == null ? null : String(row.ownerName),
      groupId: Number(row.groupId),
      groupName: row.groupName == null ? `分组 #${row.groupId}` : String(row.groupName),
      taskClass: row.taskClass == null ? null : String(row.taskClass),
      model: row.model == null ? null : String(row.model),
      description: row.describe == null ? null : String(row.describe),
      state: row.state == null ? null : String(row.state),
      startTime: row.startTime == null ? null : Number(row.startTime),
      reason: row.reason == null ? null : String(row.reason),
    })),
  };
}

export async function getUsageOverview(
  actor: AuthUser,
  input: AdminUsageInput = {},
  connection?: MonitoringConnection,
): Promise<AdminUsageOverview> {
  const scopedGroupId = resolveScopeGroup(actor, input.groupId);
  const { page, pageSize, offset } = normalizePage(input);
  assertOptionalId(input.ownerUserId, "OWNER_USER_ID_INVALID", "用户 ID ");
  assertOptionalId(input.projectId, "PROJECT_ID_INVALID", "项目 ID ");
  const db = await resolveConnection(connection);

  const applyFilters = (query: Knex.QueryBuilder) => {
    let filtered = query;
    if (scopedGroupId !== undefined) filtered = filtered.where("o_usageLedger.groupId", scopedGroupId);
    if (input.ownerUserId !== undefined) filtered = filtered.where("o_usageLedger.userId", input.ownerUserId);
    if (input.projectId !== undefined) filtered = filtered.where("o_usageLedger.projectId", input.projectId);
    if (input.taskType?.trim()) filtered = filtered.where("o_usageLedger.taskType", input.taskType.trim());
    if (input.providerId?.trim()) filtered = filtered.where("o_usageLedger.providerId", input.providerId.trim());
    if (input.modelId?.trim()) filtered = filtered.where("o_usageLedger.modelId", input.modelId.trim());
    return filtered;
  };

  const summaryRow: any = await applyFilters(db("o_usageLedger"))
    .count({ recordCount: "o_usageLedger.id" })
    .sum({ estimatedCost: "o_usageLedger.estimatedCost" })
    .first();
  const breakdownRows: any[] = await applyFilters(db("o_usageLedger"))
    .select("o_usageLedger.taskType")
    .count({ recordCount: "o_usageLedger.id" })
    .sum({ estimatedCost: "o_usageLedger.estimatedCost" })
    .groupBy("o_usageLedger.taskType")
    .orderBy("o_usageLedger.taskType", "asc");
  const rows = await applyFilters(
    db("o_usageLedger")
      .leftJoin("o_group as usageGroup", "usageGroup.id", "o_usageLedger.groupId")
      .leftJoin("o_user as usageUser", "usageUser.id", "o_usageLedger.userId")
      .leftJoin("o_project as usageProject", "usageProject.id", "o_usageLedger.projectId"),
  )
    .select(
      "o_usageLedger.id",
      "o_usageLedger.jobId",
      "o_usageLedger.groupId",
      "usageGroup.name as groupName",
      "o_usageLedger.userId",
      "usageUser.name as userName",
      "o_usageLedger.projectId",
      "usageProject.name as projectName",
      "o_usageLedger.providerId",
      "o_usageLedger.modelId",
      "o_usageLedger.taskType",
      "o_usageLedger.estimatedCost",
      "o_usageLedger.currency",
      "o_usageLedger.result",
      "o_usageLedger.createdAt",
    )
    .orderBy("o_usageLedger.createdAt", "desc")
    .orderBy("o_usageLedger.id", "desc")
    .offset(offset)
    .limit(pageSize);

  return {
    summary: {
      recordCount: Number(summaryRow?.recordCount ?? 0),
      estimatedCost: normalizeMoney(Number(summaryRow?.estimatedCost ?? 0)),
    },
    breakdown: breakdownRows.map((row: any) => ({
      taskType: String(row.taskType),
      recordCount: Number(row.recordCount),
      estimatedCost: normalizeMoney(Number(row.estimatedCost ?? 0)),
    })),
    page,
    pageSize,
    total: Number(summaryRow?.recordCount ?? 0),
    items: rows.map((row: any): AdminUsageListItem => ({
      id: Number(row.id),
      jobId: Number(row.jobId),
      groupId: Number(row.groupId),
      groupName: row.groupName == null ? `分组 #${row.groupId}` : String(row.groupName),
      userId: Number(row.userId),
      userName: row.userName == null ? `用户 #${row.userId}` : String(row.userName),
      projectId: row.projectId == null ? null : Number(row.projectId),
      projectName: row.projectName == null ? null : String(row.projectName),
      providerId: row.providerId == null ? null : String(row.providerId),
      modelId: row.modelId == null ? null : String(row.modelId),
      taskType: String(row.taskType),
      estimatedCost: row.estimatedCost == null ? null : normalizeMoney(Number(row.estimatedCost)),
      currency: row.currency == null ? null : String(row.currency),
      result: String(row.result),
      createdAt: Number(row.createdAt),
    })),
  };
}
