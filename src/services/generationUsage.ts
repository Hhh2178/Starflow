import type { Knex } from "knex";
import type { MeteringResult } from "@/types/generationQueue";

type UsageConnection = Knex | Knex.Transaction;

export interface UsageLedgerRecord {
  id: number;
  jobId: number;
  estimatedCost: number | null;
}

async function resolveConnection(connection?: UsageConnection): Promise<UsageConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

async function inTransaction<T>(
  connection: UsageConnection,
  run: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  if ((connection as Knex.Transaction).isTransaction) return run(connection as Knex.Transaction);
  return (connection as Knex).transaction(run);
}

function toUsageRecord(row: any): UsageLedgerRecord {
  return {
    id: Number(row.id),
    jobId: Number(row.jobId),
    estimatedCost: row.estimatedCost == null ? null : Number(row.estimatedCost),
  };
}

export async function completeGenerationUsage(
  jobId: number,
  result: unknown,
  metering: MeteringResult,
  connection?: UsageConnection,
  completedAt: number = Date.now(),
): Promise<UsageLedgerRecord> {
  const resolvedConnection = await resolveConnection(connection);
  return inTransaction(resolvedConnection, async (trx) => {
    const existing = await trx("o_usageLedger").where({ jobId }).first();
    if (existing) return toUsageRecord(existing);

    const job = await trx("o_generationJob").where({ id: jobId }).first();
    if (!job) throw new Error("生成任务不存在");
    await trx("o_generationJob").where({ id: jobId }).update({
      status: "succeeded",
      resultJson: JSON.stringify(result),
      providerRequestId: metering.providerRequestId ?? job.providerRequestId ?? null,
      finishedAt: completedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
    const [usageId] = await trx("o_usageLedger").insert({
      jobId,
      groupId: Number(job.groupId),
      userId: Number(job.ownerUserId),
      projectId: job.projectId == null ? null : Number(job.projectId),
      providerId: metering.providerId,
      modelId: metering.modelId,
      taskType: String(job.taskType),
      unitJson: JSON.stringify(metering.units),
      estimatedCost: metering.estimatedCost,
      currency: metering.currency,
      pricingSnapshotJson: JSON.stringify(metering.pricingSnapshot),
      result: "succeeded",
      createdAt: completedAt,
    });

    const cost = metering.estimatedCost;
    if (cost !== null && Number.isFinite(cost) && cost > 0) {
      let account = await trx("o_quotaAccount").where({ groupId: job.groupId }).first();
      if (!account) {
        await trx("o_quotaAccount").insert({ groupId: job.groupId, balance: 0, updatedAt: completedAt });
        account = { balance: 0 };
      }
      const balanceBefore = Number(account.balance);
      const balanceAfter = balanceBefore - cost;
      await trx("o_quotaLedger").insert({
        groupId: Number(job.groupId),
        entryType: "usage_debit",
        amount: -cost,
        balanceBefore,
        balanceAfter,
        actorUserId: null,
        usageLedgerId: Number(usageId),
        reason: `生成任务 #${jobId} 用量扣款`,
        createdAt: completedAt,
      });
      await trx("o_quotaAccount").where({ groupId: job.groupId }).update({ balance: balanceAfter, updatedAt: completedAt });
    }
    return toUsageRecord(await trx("o_usageLedger").where({ id: usageId }).first());
  });
}
