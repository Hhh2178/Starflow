import type { Knex } from "knex";
import type { MeteringResult } from "@/types/generationQueue";
import { fromMoneyMicros, normalizeMoney, toMoneyMicros } from "@/lib/money";
import { calculateActualCost, type PricingSnapshot } from "@/services/modelPricing";
import { settleQuotaReservation } from "@/services/quotaReservation";

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
    estimatedCost: row.estimatedCost == null ? null : normalizeMoney(Number(row.estimatedCost)),
  };
}

function parseJobPricingSnapshot(value: unknown): PricingSnapshot | null {
  if (value == null) return null;
  const parsed = JSON.parse(String(value)) as PricingSnapshot;
  return parsed && typeof parsed === "object" && Object.keys(parsed).length > 0 ? parsed : null;
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
    const reservation = await trx("o_quotaReservation").where({ jobId }).first();
    const pricingSnapshot = parseJobPricingSnapshot(job.pricingSnapshotJson);
    if (pricingSnapshot && !reservation) {
      throw new Error("计费任务预占记录不存在");
    }
    await trx("o_generationJob").where({ id: jobId }).update({
      status: "succeeded",
      resultJson: JSON.stringify(result),
      providerRequestId: metering.providerRequestId ?? job.providerRequestId ?? null,
      finishedAt: completedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
    const normalizedCost = pricingSnapshot
      ? calculateActualCost(pricingSnapshot, metering.units)
      : metering.estimatedCost == null || !Number.isFinite(metering.estimatedCost)
        ? null
        : normalizeMoney(metering.estimatedCost);
    const [usageId] = await trx("o_usageLedger").insert({
      jobId,
      groupId: Number(job.groupId),
      userId: Number(job.ownerUserId),
      projectId: job.projectId == null ? null : Number(job.projectId),
      providerId: pricingSnapshot?.providerId ?? metering.providerId,
      modelId: pricingSnapshot?.modelId ?? metering.modelId,
      taskType: String(job.taskType),
      unitJson: JSON.stringify(metering.units),
      estimatedCost: normalizedCost,
      currency: pricingSnapshot?.currency ?? metering.currency,
      pricingSnapshotJson: pricingSnapshot ? String(job.pricingSnapshotJson) : JSON.stringify(metering.pricingSnapshot),
      result: "succeeded",
      createdAt: completedAt,
    });

    const cost = normalizedCost;
    if (pricingSnapshot && cost !== null) {
      await settleQuotaReservation(trx, {
        jobId,
        usageLedgerId: Number(usageId),
        finalAmount: cost,
        completedAt,
      });
    } else if (cost !== null && cost > 0) {
      let account = await trx("o_quotaAccount").where({ groupId: job.groupId }).first();
      if (!account) {
        await trx("o_quotaAccount").insert({ groupId: job.groupId, balance: 0, updatedAt: completedAt });
        account = { balance: 0 };
      }
      const balanceBeforeMicros = toMoneyMicros(Number(account.balance));
      const costMicros = toMoneyMicros(cost);
      const balanceAfterMicros = balanceBeforeMicros - costMicros;
      const balanceBefore = fromMoneyMicros(balanceBeforeMicros);
      const balanceAfter = fromMoneyMicros(balanceAfterMicros);
      await trx("o_quotaLedger").insert({
        groupId: Number(job.groupId),
        entryType: "usage_debit",
        amount: fromMoneyMicros(-costMicros),
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
