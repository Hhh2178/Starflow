import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { writeAudit } from "@/services/auditLog";
import {
  fromMoneyMicros,
  hasMoneyPrecision,
  MAX_QUOTA_AMOUNT,
  normalizeMoney,
  toMoneyMicros,
} from "@/lib/money";

type QuotaConnection = Knex | Knex.Transaction;

export type QuotaAdjustmentEntryType = "manual_topup" | "manual_credit" | "manual_debit";

export interface QuotaAdjustmentInput {
  groupId: number;
  entryType: QuotaAdjustmentEntryType;
  amount: number;
  reason: string;
}

export class QuotaManagementError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

async function resolveConnection(connection?: QuotaConnection): Promise<QuotaConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

async function inTransaction<T>(
  connection: QuotaConnection,
  run: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  if ((connection as Knex.Transaction).isTransaction) return run(connection as Knex.Transaction);
  return (connection as Knex).transaction(run);
}

function assertAdminScope(actor: AuthUser): void {
  if (actor.role === "creator") {
    throw new QuotaManagementError(403, "ADMIN_REQUIRED", "仅管理员可以查看额度");
  }
  if (actor.role === "admin" && actor.groupId == null) {
    throw new QuotaManagementError(403, "ADMIN_GROUP_REQUIRED", "管理员尚未归属分组");
  }
}

function toLedgerDto(ledger: any, redactActor: boolean = false) {
  return {
    id: Number(ledger.id),
    groupId: Number(ledger.groupId),
    entryType: String(ledger.entryType),
    amount: normalizeMoney(Number(ledger.amount)),
    balanceBefore: normalizeMoney(Number(ledger.balanceBefore)),
    balanceAfter: normalizeMoney(Number(ledger.balanceAfter)),
    actorUserId: redactActor || ledger.actorUserId == null ? null : Number(ledger.actorUserId),
    usageLedgerId: ledger.usageLedgerId == null ? null : Number(ledger.usageLedgerId),
    reason: String(ledger.reason),
    createdAt: Number(ledger.createdAt),
  };
}

export async function getQuotaOverview(actor: AuthUser, connection?: QuotaConnection) {
  assertAdminScope(actor);
  const resolvedConnection = await resolveConnection(connection);
  let groupsQuery = resolvedConnection("o_group")
    .leftJoin("o_quotaAccount", "o_quotaAccount.groupId", "o_group.id")
    .select("o_group.id", "o_group.name", "o_quotaAccount.balance")
    .orderBy("o_group.id", "asc");
  let totalsQuery = resolvedConnection("o_quotaLedger")
    .select("groupId", "entryType", "amount");
  let logsQuery = resolvedConnection("o_quotaLedger")
    .leftJoin("o_user as actor", "actor.id", "o_quotaLedger.actorUserId")
    .select(
      "o_quotaLedger.id",
      "o_quotaLedger.groupId",
      "o_quotaLedger.entryType",
      "o_quotaLedger.amount",
      "o_quotaLedger.balanceBefore",
      "o_quotaLedger.balanceAfter",
      "o_quotaLedger.actorUserId",
      "o_quotaLedger.usageLedgerId",
      "o_quotaLedger.reason",
      "o_quotaLedger.createdAt",
      "actor.role as actorRole",
    )
    .orderBy("o_quotaLedger.createdAt", "desc")
    .orderBy("o_quotaLedger.id", "desc")
    .limit(200);
  if (actor.role === "admin") {
    groupsQuery = groupsQuery.where("o_group.id", actor.groupId);
    totalsQuery = totalsQuery.where("o_quotaLedger.groupId", actor.groupId);
    logsQuery = logsQuery.where("o_quotaLedger.groupId", actor.groupId);
  }

  const [groups, totalRows, ledgers] = await Promise.all([groupsQuery, totalsQuery, logsQuery]);
  const totals = new Map<number, { rechargeMicros: number; usageMicros: number }>();
  for (const row of totalRows as any[]) {
    const groupId = Number(row.groupId);
    const total = totals.get(groupId) ?? { rechargeMicros: 0, usageMicros: 0 };
    const amountMicros = toMoneyMicros(Number(row.amount));
    if (row.entryType === "manual_topup" && amountMicros > 0) total.rechargeMicros += amountMicros;
    if (row.entryType === "usage_debit") total.usageMicros += Math.abs(amountMicros);
    totals.set(groupId, total);
  }
  const groupDtos = groups.map((group: any) => ({
    groupId: Number(group.id),
    groupName: String(group.name),
    balance: normalizeMoney(Number(group.balance ?? 0)),
    totalRecharge: fromMoneyMicros(totals.get(Number(group.id))?.rechargeMicros ?? 0),
    totalUsage: fromMoneyMicros(totals.get(Number(group.id))?.usageMicros ?? 0),
  }));
  const summaryMicros = groupDtos.reduce(
    (summary, group) => ({
      balance: summary.balance + toMoneyMicros(group.balance),
      totalRecharge: summary.totalRecharge + toMoneyMicros(group.totalRecharge),
      totalUsage: summary.totalUsage + toMoneyMicros(group.totalUsage),
    }),
    { balance: 0, totalRecharge: 0, totalUsage: 0 },
  );
  return {
    summary: {
      balance: fromMoneyMicros(summaryMicros.balance),
      totalRecharge: fromMoneyMicros(summaryMicros.totalRecharge),
      totalUsage: fromMoneyMicros(summaryMicros.totalUsage),
    },
    groups: groupDtos,
    logs: ledgers.map((ledger: any) => toLedgerDto(
      ledger,
      actor.role === "admin" && ledger.actorRole === "super_admin",
    )),
  };
}

export async function adjustQuota(
  actor: AuthUser,
  input: QuotaAdjustmentInput,
  connection?: QuotaConnection,
) {
  if (actor.role !== "super_admin") {
    throw new QuotaManagementError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可以调整额度");
  }
  if (!Number.isInteger(input.groupId) || input.groupId <= 0) {
    throw new QuotaManagementError(422, "GROUP_ID_INVALID", "分组 ID 必须是正整数");
  }
  if (!["manual_topup", "manual_credit", "manual_debit"].includes(input.entryType)) {
    throw new QuotaManagementError(422, "ENTRY_TYPE_INVALID", "额度调整类型无效");
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new QuotaManagementError(422, "AMOUNT_INVALID", "调整金额必须大于零");
  }
  if (input.amount > MAX_QUOTA_AMOUNT) {
    throw new QuotaManagementError(422, "AMOUNT_TOO_LARGE", `调整金额不能超过 ${MAX_QUOTA_AMOUNT}`);
  }
  if (!hasMoneyPrecision(input.amount)) {
    throw new QuotaManagementError(422, "AMOUNT_PRECISION_INVALID", "调整金额最多保留 6 位小数");
  }
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 500) {
    throw new QuotaManagementError(422, "REASON_INVALID", "调整原因长度必须为 2 到 500 个字符");
  }

  const resolvedConnection = await resolveConnection(connection);
  return inTransaction(resolvedConnection, async (trx) => {
    const group = await trx("o_group").where({ id: input.groupId }).first();
    if (!group) throw new QuotaManagementError(404, "GROUP_NOT_FOUND", "分组不存在");
    const account = await trx("o_quotaAccount").where({ groupId: input.groupId }).first();
    if (!account) throw new QuotaManagementError(404, "QUOTA_ACCOUNT_NOT_FOUND", "额度账户不存在");

    const balanceBeforeMicros = toMoneyMicros(Number(account.balance));
    const amountMicros = toMoneyMicros(input.amount);
    const signedAmountMicros = input.entryType === "manual_debit" ? -amountMicros : amountMicros;
    const balanceAfterMicros = balanceBeforeMicros + signedAmountMicros;
    const balanceBefore = fromMoneyMicros(balanceBeforeMicros);
    const signedAmount = fromMoneyMicros(signedAmountMicros);
    const balanceAfter = fromMoneyMicros(balanceAfterMicros);
    const createdAt = Date.now();
    const [ledgerId] = await trx("o_quotaLedger").insert({
      groupId: input.groupId,
      entryType: input.entryType,
      amount: signedAmount,
      balanceBefore,
      balanceAfter,
      actorUserId: actor.id,
      usageLedgerId: null,
      reason,
      createdAt,
    });
    await trx("o_quotaAccount")
      .where({ groupId: input.groupId })
      .update({ balance: balanceAfter, updatedAt: createdAt });
    await writeAudit({
      actor,
      groupId: input.groupId,
      action: "quota.adjust",
      targetType: "quota_account",
      targetId: input.groupId,
      summary: {
        groupId: input.groupId,
        entryType: input.entryType,
        amount: signedAmount,
        balanceBefore,
        balanceAfter,
        reason,
      },
      result: "success",
    }, trx);

    const updatedAccount = await trx("o_quotaAccount").where({ groupId: input.groupId }).first();
    const ledger = await trx("o_quotaLedger").where({ id: ledgerId }).first();
    return {
      account: {
        groupId: Number(updatedAccount.groupId),
        balance: Number(updatedAccount.balance),
        updatedAt: Number(updatedAccount.updatedAt),
      },
      ledger: toLedgerDto(ledger),
    };
  });
}
