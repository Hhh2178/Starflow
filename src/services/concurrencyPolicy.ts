import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import type {
  CapacityDecision,
  CapacityUsage,
  ConcurrencyLimit,
  GenerationTaskType,
} from "@/types/generationQueue";

type PolicyConnection = Knex | Knex.Transaction;

async function resolveConnection(connection?: PolicyConnection): Promise<PolicyConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

export class ConcurrencyPolicyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function toLimit(row: any): ConcurrencyLimit {
  return {
    total: Number(row.totalLimit),
    text: Number(row.textLimit),
    image: Number(row.imageLimit),
    video: Number(row.videoLimit),
  };
}

function toPolicyRow(input: ConcurrencyLimit): Record<string, number> {
  return {
    totalLimit: input.total,
    textLimit: input.text,
    imageLimit: input.image,
    videoLimit: input.video,
  };
}

async function findPolicy(
  connection: PolicyConnection,
  scopeType: "group" | "user",
  scopeId: number,
): Promise<ConcurrencyLimit> {
  const row = await connection("o_concurrencyPolicy").where({ scopeType, scopeId }).first();
  if (!row) throw new ConcurrencyPolicyError(404, "POLICY_NOT_FOUND", "并发策略不存在");
  return toLimit(row);
}

function assertUserWithinGroup(user: ConcurrencyLimit, group: ConcurrencyLimit): void {
  if (user.total > group.total) {
    throw new ConcurrencyPolicyError(422, "USER_TOTAL_EXCEEDS_GROUP", "个人总并发不能超过分组总并发");
  }
  const labels: Record<GenerationTaskType, string> = { text: "文本", image: "图片", video: "视频" };
  for (const taskType of ["text", "image", "video"] as const) {
    if (user[taskType] > group[taskType]) {
      throw new ConcurrencyPolicyError(
        422,
        "USER_TYPE_EXCEEDS_GROUP",
        `个人${labels[taskType]}并发不能超过分组${labels[taskType]}并发`,
      );
    }
  }
}

export function evaluateCapacity(input: {
  taskType: GenerationTaskType;
  group: CapacityUsage;
  user: CapacityUsage;
  groupLimit: ConcurrencyLimit;
  userLimit: ConcurrencyLimit;
}): CapacityDecision {
  const { taskType, group, user, groupLimit, userLimit } = input;
  if (group.total >= groupLimit.total) return { allowed: false, reason: "GROUP_TOTAL_LIMIT" };
  if (group[taskType] >= groupLimit[taskType]) return { allowed: false, reason: "GROUP_TYPE_LIMIT" };
  if (user.total >= userLimit.total) return { allowed: false, reason: "USER_TOTAL_LIMIT" };
  if (user[taskType] >= userLimit[taskType]) return { allowed: false, reason: "USER_TYPE_LIMIT" };
  return { allowed: true };
}

export async function updateGroupPolicy(
  actor: AuthUser,
  groupId: number,
  input: ConcurrencyLimit,
  connection?: PolicyConnection,
): Promise<ConcurrencyLimit> {
  const resolvedConnection = await resolveConnection(connection);
  if (actor.role !== "super_admin") {
    throw new ConcurrencyPolicyError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可以修改分组并发策略");
  }
  if (!(await resolvedConnection("o_group").where({ id: groupId }).first())) {
    throw new ConcurrencyPolicyError(404, "GROUP_NOT_FOUND", "分组不存在");
  }

  const now = Date.now();
  await resolvedConnection("o_concurrencyPolicy")
    .insert({
      scopeType: "group",
      scopeId: groupId,
      ...toPolicyRow(input),
      updatedBy: actor.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict(["scopeType", "scopeId"])
    .merge({ ...toPolicyRow(input), updatedBy: actor.id, updatedAt: now });
  return findPolicy(resolvedConnection, "group", groupId);
}

export async function updateUserPolicy(
  actor: AuthUser,
  userId: number,
  input: ConcurrencyLimit,
  connection?: PolicyConnection,
): Promise<ConcurrencyLimit> {
  const resolvedConnection = await resolveConnection(connection);
  if (actor.role === "creator") {
    throw new ConcurrencyPolicyError(403, "ADMIN_REQUIRED", "仅管理员可以修改个人并发策略");
  }

  const target = await resolvedConnection("o_user").where({ id: userId }).select("id", "role", "groupId").first();
  const targetGroupId = target?.groupId == null ? null : Number(target.groupId);
  const canManage = actor.role === "super_admin"
    ? target?.role === "admin" || target?.role === "creator"
    : target?.role === "creator" && targetGroupId === actor.groupId;
  if (!target || !canManage || targetGroupId === null) {
    throw new ConcurrencyPolicyError(404, "USER_NOT_FOUND", "用户不存在");
  }

  const groupPolicy = await findPolicy(resolvedConnection, "group", targetGroupId);
  assertUserWithinGroup(input, groupPolicy);
  const now = Date.now();
  await resolvedConnection("o_concurrencyPolicy")
    .insert({
      scopeType: "user",
      scopeId: userId,
      ...toPolicyRow(input),
      updatedBy: actor.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflict(["scopeType", "scopeId"])
    .merge({ ...toPolicyRow(input), updatedBy: actor.id, updatedAt: now });
  return findPolicy(resolvedConnection, "user", userId);
}

export async function getEffectivePolicies(
  groupId: number,
  userId: number,
  connection?: PolicyConnection,
): Promise<{ group: ConcurrencyLimit; user: ConcurrencyLimit }> {
  const resolvedConnection = await resolveConnection(connection);
  const user = await resolvedConnection("o_user").where({ id: userId, groupId }).first();
  if (!user) throw new ConcurrencyPolicyError(404, "USER_NOT_FOUND", "用户不存在");
  const [group, userPolicy] = await Promise.all([
    findPolicy(resolvedConnection, "group", groupId),
    findPolicy(resolvedConnection, "user", userId),
  ]);
  return { group, user: userPolicy };
}

export async function getScopedEffectivePolicies(
  actor: AuthUser,
  groupId: number,
  userId: number,
  connection?: PolicyConnection,
): Promise<{ group: ConcurrencyLimit; user: ConcurrencyLimit }> {
  if (actor.role === "creator") {
    throw new ConcurrencyPolicyError(403, "ADMIN_REQUIRED", "仅管理员可以查看并发策略");
  }
  const resolvedConnection = await resolveConnection(connection);
  if (actor.role === "admin") {
    const target = groupId === actor.groupId
      ? await resolvedConnection("o_user").where({ id: userId, groupId, role: "creator" }).first()
      : undefined;
    if (!target) throw new ConcurrencyPolicyError(404, "USER_NOT_FOUND", "用户不存在");
  }
  return getEffectivePolicies(groupId, userId, resolvedConnection);
}
