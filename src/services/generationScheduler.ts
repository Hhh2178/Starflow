import type { Knex } from "knex";
import { evaluateCapacity } from "@/services/concurrencyPolicy";
import type { CapacityUsage, ConcurrencyLimit, GenerationTaskType } from "@/types/generationQueue";
import type { GenerationJobRecord } from "@/services/generationQueue";

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
