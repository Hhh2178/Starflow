import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import type { GenerationJobStatus, GenerationTaskType } from "@/types/generationQueue";

type QueueConnection = Knex | Knex.Transaction;

export interface EnqueueGenerationInput {
  projectId: number;
  sourceTaskId?: number;
  handlerKey: string;
  taskType: GenerationTaskType;
  payload: unknown;
  idempotencyKey: string;
}

export interface GenerationJobRecord {
  id: number;
  groupId: number;
  ownerUserId: number;
  projectId: number | null;
  sourceTaskId: number | null;
  handlerKey: string;
  taskType: GenerationTaskType;
  status: GenerationJobStatus;
  priority: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export class GenerationQueueError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function resolveConnection(connection?: QueueConnection): Promise<QueueConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

function toJobRecord(row: any): GenerationJobRecord {
  return {
    id: Number(row.id),
    groupId: Number(row.groupId),
    ownerUserId: Number(row.ownerUserId),
    projectId: row.projectId == null ? null : Number(row.projectId),
    sourceTaskId: row.sourceTaskId == null ? null : Number(row.sourceTaskId),
    handlerKey: String(row.handlerKey),
    taskType: row.taskType as GenerationTaskType,
    status: row.status as GenerationJobStatus,
    priority: Number(row.priority),
    queuedAt: Number(row.queuedAt),
    startedAt: row.startedAt == null ? null : Number(row.startedAt),
    finishedAt: row.finishedAt == null ? null : Number(row.finishedAt),
  };
}

function canAccessProject(actor: AuthUser, project: any): boolean {
  if (actor.role === "super_admin") return true;
  if (actor.role === "admin") return Number(project.groupId) === actor.groupId;
  return Number(project.ownerUserId) === actor.id;
}

function applyJobScope(query: Knex.QueryBuilder, actor: AuthUser): Knex.QueryBuilder {
  if (actor.role === "super_admin") return query;
  if (actor.role === "admin") return query.where("groupId", actor.groupId);
  return query.where("ownerUserId", actor.id);
}

async function inTransaction<T>(
  connection: QueueConnection,
  run: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  if ((connection as Knex.Transaction).isTransaction) return run(connection as Knex.Transaction);
  return (connection as Knex).transaction(run);
}

export async function enqueueGeneration(
  actor: AuthUser,
  input: EnqueueGenerationInput,
  connection?: QueueConnection,
): Promise<GenerationJobRecord> {
  const resolvedConnection = await resolveConnection(connection);
  const project = await resolvedConnection("o_project").where({ id: input.projectId }).first();
  if (!project || !canAccessProject(actor, project) || project.groupId == null || project.ownerUserId == null) {
    throw new GenerationQueueError(404, "PROJECT_NOT_FOUND", "项目不存在或当前账号无权访问");
  }

  const duplicate = await resolvedConnection("o_generationJob").where({ idempotencyKey: input.idempotencyKey }).first();
  if (duplicate) {
    if (Number(duplicate.projectId) !== input.projectId) {
      throw new GenerationQueueError(409, "IDEMPOTENCY_KEY_CONFLICT", "幂等键已被其他任务使用");
    }
    return toJobRecord(duplicate);
  }

  const queuedAt = Date.now();
  const [id] = await resolvedConnection("o_generationJob").insert({
    groupId: Number(project.groupId),
    ownerUserId: Number(project.ownerUserId),
    projectId: input.projectId,
    sourceTaskId: input.sourceTaskId ?? null,
    handlerKey: input.handlerKey,
    taskType: input.taskType,
    status: "queued",
    priority: 0,
    payloadJson: JSON.stringify(input.payload),
    idempotencyKey: input.idempotencyKey,
    queuedAt,
  });
  return toJobRecord(await resolvedConnection("o_generationJob").where({ id }).first());
}

export async function cancelGenerationJob(
  actor: AuthUser,
  jobId: number,
  connection?: QueueConnection,
): Promise<GenerationJobRecord> {
  const resolvedConnection = await resolveConnection(connection);
  return inTransaction(resolvedConnection, async (trx) => {
    const job = await applyJobScope(trx("o_generationJob").where({ id: jobId }), actor).first();
    if (!job) throw new GenerationQueueError(404, "JOB_NOT_FOUND", "任务不存在");

    const now = Date.now();
    if (job.status === "queued") {
      await trx("o_generationJob")
        .where({ id: jobId, status: "queued" })
        .update({ status: "cancelled", cancellationRequestedAt: now, finishedAt: now });
    } else if (job.status === "running" || job.status === "recovering") {
      await trx("o_generationJob")
        .where({ id: jobId })
        .whereIn("status", ["running", "recovering"])
        .update({ cancellationRequestedAt: now });
    }
    return toJobRecord(await trx("o_generationJob").where({ id: jobId }).first());
  });
}

export async function reprioritizeGenerationJob(
  actor: AuthUser,
  jobId: number,
  priority: number,
  reason: string,
  connection?: QueueConnection,
): Promise<GenerationJobRecord> {
  if (actor.role !== "super_admin") {
    throw new GenerationQueueError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可以调整任务优先级");
  }
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new GenerationQueueError(422, "REASON_REQUIRED", "调整优先级时必须填写原因");
  if (!Number.isInteger(priority)) throw new GenerationQueueError(422, "PRIORITY_INVALID", "优先级必须是整数");

  const resolvedConnection = await resolveConnection(connection);
  return inTransaction(resolvedConnection, async (trx) => {
    const job = await trx("o_generationJob").where({ id: jobId }).first();
    if (!job) throw new GenerationQueueError(404, "JOB_NOT_FOUND", "任务不存在");
    if (job.status !== "queued") {
      throw new GenerationQueueError(409, "JOB_NOT_QUEUED", "只有排队中的任务可以调整优先级");
    }

    await trx("o_generationJob").where({ id: jobId, status: "queued" }).update({ priority });
    await trx("o_auditLog").insert({
      actorUserId: actor.id,
      actorRole: actor.role,
      groupId: Number(job.groupId),
      action: "queue.reprioritize",
      targetType: "generation_job",
      targetId: String(jobId),
      summaryJson: JSON.stringify({ priority, reason: normalizedReason.slice(0, 200) }),
      result: "success",
      requestId: null,
      createdAt: Date.now(),
    });
    return toJobRecord(await trx("o_generationJob").where({ id: jobId }).first());
  });
}
