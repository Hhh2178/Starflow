import type { Knex } from "knex";
import { evaluateCapacity } from "@/services/concurrencyPolicy";
import type { CapacityUsage, ConcurrencyLimit, GenerationExecutionContext, GenerationTaskType } from "@/types/generationQueue";
import type { GenerationJobRecord } from "@/services/generationQueue";
import type { GenerationJobRegistry } from "@/jobs/registry";
import { completeGenerationUsage } from "@/services/generationUsage";

type SchedulerConnection = Knex | Knex.Transaction;

export interface QueueCandidate {
  id: number;
  ownerUserId: number;
  priority: number;
  queuedAt: number;
}

export interface ClaimOptions {
  connection?: SchedulerConnection;
  leaseOwner: string;
  now?: number;
}

export interface RecoveryOptions {
  connection?: SchedulerConnection;
  registry: GenerationJobRegistry;
  now?: number;
}

export interface ExecuteClaimedJobOptions {
  connection?: SchedulerConnection;
  registry: GenerationJobRegistry;
  heartbeatIntervalMs?: number;
  now?: () => number;
}

function sortFairCandidates(queued: QueueCandidate[], lastStartedByUser: Map<number, number>): QueueCandidate[] {
  const fifoHeads = new Map<number, QueueCandidate>();
  for (const candidate of queued) {
    const current = fifoHeads.get(candidate.ownerUserId);
    if (!current || candidate.queuedAt < current.queuedAt || (candidate.queuedAt === current.queuedAt && candidate.id < current.id)) {
      fifoHeads.set(candidate.ownerUserId, candidate);
    }
  }
  return [...fifoHeads.values()].sort((a, b) => {
    const aLast = lastStartedByUser.get(a.ownerUserId) ?? 0;
    const bLast = lastStartedByUser.get(b.ownerUserId) ?? 0;
    if (aLast !== bLast) return aLast - bLast;
    return b.priority - a.priority || a.queuedAt - b.queuedAt || a.id - b.id;
  });
}

export function chooseFairCandidate(
  queued: QueueCandidate[],
  lastStartedByUser: Map<number, number>,
): QueueCandidate | null {
  return sortFairCandidates(queued, lastStartedByUser)[0] ?? null;
}

function toLimit(row: any): ConcurrencyLimit {
  return {
    total: Number(row.totalLimit),
    text: Number(row.textLimit),
    image: Number(row.imageLimit),
    video: Number(row.videoLimit),
  };
}

function toUsage(rows: any[]): CapacityUsage {
  const usage: CapacityUsage = { total: 0, text: 0, image: 0, video: 0 };
  for (const row of rows) {
    const taskType = row.taskType as GenerationTaskType;
    const count = Number(row.count);
    usage.total += count;
    usage[taskType] += count;
  }
  return usage;
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
    status: row.status,
    priority: Number(row.priority),
    queuedAt: Number(row.queuedAt),
    startedAt: row.startedAt == null ? null : Number(row.startedAt),
    finishedAt: row.finishedAt == null ? null : Number(row.finishedAt),
  };
}

async function resolveConnection(connection?: SchedulerConnection): Promise<SchedulerConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

async function inTransaction<T>(
  connection: SchedulerConnection,
  run: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  if ((connection as Knex.Transaction).isTransaction) return run(connection as Knex.Transaction);
  return (connection as Knex).transaction(run);
}

export async function claimNextJob(groupId: number, options: ClaimOptions): Promise<GenerationJobRecord | null> {
  const connection = await resolveConnection(options.connection);
  return inTransaction(connection, async (trx) => {
    const groupPolicyRow = await trx("o_concurrencyPolicy").where({ scopeType: "group", scopeId: groupId }).first();
    if (!groupPolicyRow) return null;

    const runningRows = await trx("o_generationJob")
      .where({ groupId, status: "running" })
      .select("ownerUserId", "taskType")
      .count({ count: "id" })
      .groupBy("ownerUserId", "taskType") as Array<{
        ownerUserId: number;
        taskType: GenerationTaskType;
        count: number | string;
      }>;
    const groupUsage = toUsage(runningRows);
    const userUsage = new Map<number, CapacityUsage>();
    for (const row of runningRows) {
      const userId = Number(row.ownerUserId);
      const usage = userUsage.get(userId) ?? { total: 0, text: 0, image: 0, video: 0 };
      const taskType = row.taskType as GenerationTaskType;
      const count = Number(row.count);
      usage.total += count;
      usage[taskType] += count;
      userUsage.set(userId, usage);
    }

    const queuedRows = await trx("o_generationJob").where({ groupId, status: "queued" }).select("*");
    if (queuedRows.length === 0) return null;
    const historyRows = await trx("o_generationJob")
      .where({ groupId })
      .whereNotNull("startedAt")
      .select("ownerUserId")
      .max({ lastStartedAt: "startedAt" })
      .groupBy("ownerUserId");
    const lastStartedByUser = new Map(
      historyRows.map((row: any) => [Number(row.ownerUserId), Number(row.lastStartedAt)] as const),
    );

    const sorted = sortFairCandidates(queuedRows.map((row: any) => ({
      id: Number(row.id),
      ownerUserId: Number(row.ownerUserId),
      priority: Number(row.priority),
      queuedAt: Number(row.queuedAt),
    })), lastStartedByUser);

    for (const candidate of sorted) {
      const row = queuedRows.find((item: any) => Number(item.id) === candidate.id);
      const userPolicyRow = await trx("o_concurrencyPolicy")
        .where({ scopeType: "user", scopeId: candidate.ownerUserId })
        .first();
      if (!userPolicyRow) continue;
      const decision = evaluateCapacity({
        taskType: row.taskType,
        group: groupUsage,
        user: userUsage.get(candidate.ownerUserId) ?? { total: 0, text: 0, image: 0, video: 0 },
        groupLimit: toLimit(groupPolicyRow),
        userLimit: toLimit(userPolicyRow),
      });
      if (!decision.allowed) continue;

      const latestStart = await trx("o_generationJob").where({ groupId }).max({ value: "startedAt" }).first();
      const requestedNow = options.now ?? Date.now();
      const startedAt = Math.max(requestedNow, Number(latestStart?.value ?? 0) + 1);
      const updated = await trx("o_generationJob")
        .where({ id: candidate.id, status: "queued" })
        .update({
          status: "running",
          leaseOwner: options.leaseOwner,
          leaseExpiresAt: startedAt + 30_000,
          heartbeatAt: startedAt,
          startedAt,
          attemptCount: trx.raw("attemptCount + 1"),
        });
      if (updated === 1) return toJobRecord(await trx("o_generationJob").where({ id: candidate.id }).first());
    }
    return null;
  });
}

export async function recoverExpiredJobs(
  options: RecoveryOptions,
): Promise<{ requeued: number; needsAttention: number }> {
  const connection = await resolveConnection(options.connection);
  const now = options.now ?? Date.now();
  return inTransaction(connection, async (trx) => {
    const expired = await trx("o_generationJob")
      .where({ status: "running" })
      .whereNotNull("leaseExpiresAt")
      .where("leaseExpiresAt", "<=", now)
      .select("*");
    let requeued = 0;
    let needsAttention = 0;

    for (const job of expired) {
      const handler = options.registry.get(String(job.handlerKey));
      const safeToRetry = job.providerRequestId == null || handler?.canRetryAfterProviderSubmission === true;
      if (safeToRetry) {
        const updated = await trx("o_generationJob")
          .where({ id: job.id, status: "running" })
          .update({
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            startedAt: null,
            errorCode: null,
            errorMessage: null,
          });
        requeued += updated;
      } else {
        const updated = await trx("o_generationJob")
          .where({ id: job.id, status: "running" })
          .update({
            status: "needs_attention",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            errorCode: "EXTERNAL_STATE_UNKNOWN",
            errorMessage: "Provider 已接收请求，无法安全自动重试",
            finishedAt: now,
          });
        needsAttention += updated;
      }
    }
    return { requeued, needsAttention };
  });
}

export async function executeClaimedJob(jobId: number, options: ExecuteClaimedJobOptions): Promise<void> {
  const connection = await resolveConnection(options.connection);
  const now = options.now ?? Date.now;
  const job = await connection("o_generationJob").where({ id: jobId, status: "running" }).first();
  if (!job) throw new Error("运行中的生成任务不存在");
  const handler = options.registry.get(String(job.handlerKey));
  if (!handler || handler.taskType !== job.taskType) {
    await connection("o_generationJob").where({ id: jobId, status: "running" }).update({
      status: "needs_attention",
      errorCode: "HANDLER_NOT_FOUND",
      errorMessage: "找不到可信的任务处理器",
      finishedAt: now(),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
    return;
  }

  if (job.cancellationRequestedAt != null) {
    await connection("o_generationJob").where({ id: jobId, status: "running" }).update({
      status: "cancelled",
      finishedAt: now(),
      errorCode: null,
      errorMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
    return;
  }

  const controller = new AbortController();
  let cancellationHookStarted = false;
  let context: GenerationExecutionContext;
  const propagateCancellation = async () => {
    const current = await connection("o_generationJob")
      .where({ id: jobId, status: "running" })
      .select("cancellationRequestedAt")
      .first();
    if (!current || current.cancellationRequestedAt == null) return false;
    if (!controller.signal.aborted) controller.abort();
    if (handler.cancel && !cancellationHookStarted) {
      cancellationHookStarted = true;
      try {
        await handler.cancel(context);
      } catch {
        // The AbortSignal remains authoritative when an optional Provider cancel hook fails.
      }
    }
    return true;
  };
  const heartbeat = async () => {
    if (await propagateCancellation()) return;
    const timestamp = now();
    await connection("o_generationJob").where({ id: jobId, status: "running" }).update({
      heartbeatAt: timestamp,
      leaseExpiresAt: timestamp + 30_000,
    });
  };
  context = {
    jobId,
    groupId: Number(job.groupId),
    ownerUserId: Number(job.ownerUserId),
    projectId: job.projectId == null ? null : Number(job.projectId),
    signal: controller.signal,
    heartbeat,
    setProviderRequestId: async (id: string) => {
      await connection("o_generationJob").where({ id: jobId, status: "running" }).update({ providerRequestId: id });
    },
  };
  const intervalMs = options.heartbeatIntervalMs ?? 10_000;
  const timer = intervalMs > 0 ? setInterval(() => void heartbeat().catch(() => undefined), intervalMs) : null;
  let providerCompleted = false;

  try {
    const payload = handler.parsePayload(JSON.parse(String(job.payloadJson)));
    const execution = await handler.execute(context, payload);
    providerCompleted = true;
    await completeGenerationUsage(jobId, execution.result, execution.metering, connection, now());
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    await connection("o_generationJob").where({ id: jobId, status: "running" }).update({
      status: cancelled ? "cancelled" : providerCompleted ? "needs_attention" : "failed",
      errorCode: cancelled ? null : providerCompleted ? "ACCOUNTING_FAILED" : "HANDLER_EXECUTION_FAILED",
      errorMessage: cancelled ? null : (error instanceof Error ? error.message : String(error)).slice(0, 500),
      finishedAt: now(),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
  } finally {
    if (timer) clearInterval(timer);
  }
}
