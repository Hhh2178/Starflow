import type { Knex } from "knex";
import {
  calculateReservedCost,
  fromMoneyMicros,
  getActivePricingSnapshot,
  resolvePricingTarget,
  toMoneyMicros,
} from "@/services/modelPricing";
import type { BillingUnits, GenerationTaskType, PricingSnapshot } from "@/types/generationQueue";

export class QuotaReservationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "QuotaReservationError";
  }
}

export interface ReserveQuotaInput {
  jobId: number;
  groupId: number;
  taskType: GenerationTaskType;
  model: string;
  units: BillingUnits;
}

export interface QuotaReservationResult {
  reservedAmount: number;
  pricingSnapshot: PricingSnapshot;
}

export async function reserveQuotaForJob(
  trx: Knex.Transaction,
  input: ReserveQuotaInput,
): Promise<QuotaReservationResult> {
  const existing = await trx("o_quotaReservation").where({ jobId: input.jobId }).first();
  if (existing) {
    const job = await trx("o_generationJob").where({ id: input.jobId }).first();
    return {
      reservedAmount: Number(existing.reservedAmount),
      pricingSnapshot: JSON.parse(String(job.pricingSnapshotJson)),
    };
  }

  const target = await resolvePricingTarget(input.taskType, input.model, trx);
  const pricingSnapshot = await getActivePricingSnapshot(target, input.taskType, trx);
  const reservedAmount = calculateReservedCost(pricingSnapshot, input.units);
  const reservedMicros = toMoneyMicros(reservedAmount);
  let account = await trx("o_quotaAccount").where({ groupId: input.groupId }).first();
  if (!account) {
    await trx("o_quotaAccount").insert({
      groupId: input.groupId,
      balance: 0,
      reservedBalance: 0,
      billingStatus: "active",
      updatedAt: Date.now(),
    });
    account = { balance: 0, reservedBalance: 0, billingStatus: "active" };
  }
  if (String(account.billingStatus) === "debt" || Number(account.balance) < 0) {
    throw new QuotaReservationError(409, "ACCOUNT_IN_DEBT", "当前分组存在欠费，请充值后再提交");
  }
  const balanceMicros = toMoneyMicros(Number(account.balance));
  const frozenMicros = toMoneyMicros(Number(account.reservedBalance ?? 0));
  if (balanceMicros - frozenMicros < reservedMicros) {
    throw new QuotaReservationError(409, "INSUFFICIENT_QUOTA", "当前分组可用额度不足");
  }

  const now = Date.now();
  await trx("o_quotaReservation").insert({
    jobId: input.jobId,
    groupId: input.groupId,
    pricingId: pricingSnapshot.pricingId,
    reservedAmount,
    finalAmount: null,
    status: "reserved",
    reason: null,
    createdAt: now,
    settledAt: null,
    releasedAt: null,
  });
  const nextReservedBalance = fromMoneyMicros(frozenMicros + reservedMicros);
  await trx("o_quotaAccount").where({ groupId: input.groupId }).update({
    reservedBalance: nextReservedBalance,
    updatedAt: now,
  });
  await trx("o_generationJob").where({ id: input.jobId }).update({
    pricingSnapshotJson: JSON.stringify(pricingSnapshot),
    reservedAmount,
  });
  return { reservedAmount, pricingSnapshot };
}

export async function releaseQuotaReservation(
  trx: Knex.Transaction,
  jobId: number,
  reason: string,
): Promise<void> {
  const reservation = await trx("o_quotaReservation").where({ jobId }).first();
  if (!reservation || reservation.status !== "reserved") return;
  const account = await trx("o_quotaAccount").where({ groupId: reservation.groupId }).first();
  if (!account) {
    throw new QuotaReservationError(409, "QUOTA_ACCOUNT_NOT_FOUND", "额度账户不存在");
  }
  const frozenMicros = toMoneyMicros(Number(account.reservedBalance ?? 0));
  const releaseMicros = toMoneyMicros(Number(reservation.reservedAmount));
  const nextFrozenMicros = frozenMicros > releaseMicros ? frozenMicros - releaseMicros : 0n;
  const now = Date.now();
  await trx("o_quotaAccount").where({ groupId: reservation.groupId }).update({
    reservedBalance: fromMoneyMicros(nextFrozenMicros),
    updatedAt: now,
  });
  await trx("o_quotaReservation").where({ id: reservation.id, status: "reserved" }).update({
    status: "released",
    finalAmount: 0,
    reason,
    releasedAt: now,
  });
}

export async function settleQuotaReservation(
  trx: Knex.Transaction,
  input: { jobId: number; usageLedgerId: number; finalAmount: number; completedAt: number },
): Promise<void> {
  const reservation = await trx("o_quotaReservation").where({ jobId: input.jobId }).first();
  if (!reservation || reservation.status === "settled") return;
  if (reservation.status !== "reserved") {
    throw new QuotaReservationError(409, "RESERVATION_NOT_AVAILABLE", "任务额度预占已释放");
  }
  const account = await trx("o_quotaAccount").where({ groupId: reservation.groupId }).first();
  if (!account) {
    throw new QuotaReservationError(409, "QUOTA_ACCOUNT_NOT_FOUND", "额度账户不存在");
  }
  const balanceBeforeMicros = toMoneyMicros(Number(account.balance));
  const frozenMicros = toMoneyMicros(Number(account.reservedBalance ?? 0));
  const reservedMicros = toMoneyMicros(Number(reservation.reservedAmount));
  const finalMicros = toMoneyMicros(input.finalAmount);
  const balanceAfterMicros = balanceBeforeMicros - finalMicros;
  const nextFrozenMicros = frozenMicros > reservedMicros ? frozenMicros - reservedMicros : 0n;
  const balanceBefore = fromMoneyMicros(balanceBeforeMicros);
  const balanceAfter = fromMoneyMicros(balanceAfterMicros);

  await trx("o_quotaLedger").insert({
    groupId: Number(reservation.groupId),
    entryType: "usage_debit",
    amount: fromMoneyMicros(-finalMicros),
    balanceBefore,
    balanceAfter,
    actorUserId: null,
    usageLedgerId: input.usageLedgerId,
    reason: `生成任务 #${input.jobId} 用量扣款`,
    createdAt: input.completedAt,
  });
  await trx("o_quotaAccount").where({ groupId: reservation.groupId }).update({
    balance: balanceAfter,
    reservedBalance: fromMoneyMicros(nextFrozenMicros),
    billingStatus: balanceAfterMicros < 0n ? "debt" : "active",
    updatedAt: input.completedAt,
  });
  await trx("o_quotaReservation").where({ id: reservation.id, status: "reserved" }).update({
    status: "settled",
    finalAmount: input.finalAmount,
    reason: "succeeded",
    settledAt: input.completedAt,
  });
}
