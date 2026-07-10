import type { Knex } from "knex";
import type { AuthUser, UserRole } from "@/types/auth";
import { db } from "@/utils/db";

const SUMMARY_KEYS = new Set([
  "name",
  "role",
  "status",
  "groupId",
  "creatorLimit",
  "projectId",
  "ownerUserId",
  "changedFields",
  "reasonCode",
  "resourceKind",
  "route",
  "entryType",
  "amount",
  "balanceBefore",
  "balanceAfter",
  "reason",
  "priority",
]);

const SENSITIVE_TEXT = /password|passwordHash|apiKey|databasePassword|accessToken|refreshToken|secret|token/i;

type AuditScalar = string | number | boolean | null;
type AuditConnection = Knex | Knex.Transaction;

export interface AuditListInput {
  page?: number;
  pageSize?: number;
  groupId?: number;
}

export class AuditLogError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

function sanitizeSummary(summary: Record<string, unknown>): Record<string, AuditScalar> {
  const sanitized: Record<string, AuditScalar> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (!SUMMARY_KEYS.has(key) || SENSITIVE_TEXT.test(key)) continue;
    if (value === null || ["number", "boolean"].includes(typeof value)) sanitized[key] = value as AuditScalar;
    if (typeof value === "string") sanitized[key] = SENSITIVE_TEXT.test(value) ? "[已脱敏]" : value;
  }
  return sanitized;
}

function parseSafeSummary(value: unknown): Record<string, AuditScalar> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return sanitizeSummary(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

const roleLabels: Record<UserRole, string> = {
  super_admin: "超级管理员",
  admin: "管理员",
  creator: "创作者",
};

const actionLabels: Record<string, string> = {
  "quota.adjust": "额度调整",
  "queue.reprioritize": "任务优先级调整",
  "user.create": "创建用户",
  "user.update": "更新用户",
  "user.reset_password": "重置密码",
  "group.create": "创建分组",
  "group.update": "更新分组",
};

const targetTypeLabels: Record<string, string> = {
  quota_account: "额度账户",
  generation_job: "生成任务",
  user: "用户",
  group: "分组",
  project: "项目",
};

export async function writeAudit(
  input: {
    actor: AuthUser;
    groupId: number | null;
    action: string;
    targetType: string;
    targetId?: string | number;
    summary: Record<string, AuditScalar>;
    result: "success" | "failure";
    requestId?: string;
  },
  connection: AuditConnection = db,
): Promise<void> {
  await connection("o_auditLog").insert({
    actorUserId: input.actor.id,
    actorRole: input.actor.role,
    groupId: input.groupId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId == null ? null : String(input.targetId),
    summaryJson: JSON.stringify(sanitizeSummary(input.summary)),
    result: input.result,
    requestId: input.requestId ?? null,
    createdAt: Date.now(),
  });
}

export async function listAudit(
  actor: AuthUser,
  input: AuditListInput = {},
  connection: AuditConnection = db,
) {
  if (actor.role === "creator") {
    throw new AuditLogError(403, "ADMIN_REQUIRED", "仅管理员可以查看审计日志");
  }
  if (actor.role === "admin" && actor.groupId == null) {
    throw new AuditLogError(403, "ADMIN_GROUP_REQUIRED", "管理员尚未归属分组");
  }
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(page) || page <= 0) {
    throw new AuditLogError(422, "PAGE_INVALID", "页码必须是正整数");
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 100) {
    throw new AuditLogError(422, "PAGE_SIZE_INVALID", "每页数量必须是 1 到 100 的整数");
  }
  if (input.groupId !== undefined && (!Number.isInteger(input.groupId) || input.groupId <= 0)) {
    throw new AuditLogError(422, "GROUP_ID_INVALID", "分组 ID 必须是正整数");
  }

  const createQuery = () => connection("o_auditLog")
    .leftJoin("o_user as targetUser", "targetUser.id", "o_auditLog.targetId");
  const applyScope = (query: Knex.QueryBuilder) => {
    if (actor.role === "admin") {
      return query
        .where("o_auditLog.groupId", actor.groupId)
        .whereNot("o_auditLog.actorRole", "super_admin")
        .andWhere(function () {
          this.whereNot("o_auditLog.targetType", "user")
            .orWhereNull("targetUser.role")
            .orWhereNotIn("targetUser.role", ["admin", "super_admin"]);
        });
    }
    return input.groupId === undefined
      ? query
      : query.where("o_auditLog.groupId", input.groupId);
  };
  const countRow = await applyScope(createQuery())
    .count({ count: "o_auditLog.id" })
    .first();
  const rows = await applyScope(createQuery())
    .select(
      "o_auditLog.id",
      "o_auditLog.actorUserId",
      "o_auditLog.actorRole",
      "o_auditLog.groupId",
      "o_auditLog.action",
      "o_auditLog.targetType",
      "o_auditLog.targetId",
      "o_auditLog.summaryJson",
      "o_auditLog.result",
      "o_auditLog.requestId",
      "o_auditLog.createdAt",
    )
    .orderBy("o_auditLog.createdAt", "desc")
    .orderBy("o_auditLog.id", "desc")
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    page,
    pageSize,
    total: Number(countRow?.count ?? 0),
    items: rows.map((row: any) => {
      const actorRole = String(row.actorRole) as UserRole;
      const action = String(row.action);
      const targetType = String(row.targetType);
      const result = String(row.result);
      return {
        id: Number(row.id),
        actorUserId: Number(row.actorUserId),
        actorRole,
        actorRoleLabel: roleLabels[actorRole] ?? "未知角色",
        groupId: row.groupId == null ? null : Number(row.groupId),
        action,
        actionLabel: actionLabels[action] ?? "系统操作",
        targetType,
        targetTypeLabel: targetTypeLabels[targetType] ?? "系统资源",
        targetId: row.targetId == null ? null : String(row.targetId),
        summary: parseSafeSummary(row.summaryJson),
        result,
        resultLabel: result === "success" ? "成功" : "失败",
        requestId: row.requestId == null ? null : String(row.requestId),
        createdAt: Number(row.createdAt),
      };
    }),
  };
}
