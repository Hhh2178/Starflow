import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";

type QuotaConnection = Knex | Knex.Transaction;

export class QuotaManagementError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

async function resolveConnection(connection?: QuotaConnection): Promise<QuotaConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

export async function getQuotaOverview(actor: AuthUser, connection?: QuotaConnection) {
  if (actor.role !== "super_admin") {
    throw new QuotaManagementError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可以查看全局额度");
  }
  const resolvedConnection = await resolveConnection(connection);
  const [groups, ledgers] = await Promise.all([
    resolvedConnection("o_group")
      .leftJoin("o_quotaAccount", "o_quotaAccount.groupId", "o_group.id")
      .select("o_group.id", "o_group.name", "o_quotaAccount.balance")
      .orderBy("o_group.id", "asc"),
    resolvedConnection("o_quotaLedger").select("*").orderBy("createdAt", "desc").orderBy("id", "desc").limit(200),
  ]);
  const totals = new Map<number, { recharge: number; usage: number }>();
  for (const ledger of ledgers) {
    const groupId = Number(ledger.groupId);
    const total = totals.get(groupId) ?? { recharge: 0, usage: 0 };
    const amount = Number(ledger.amount);
    if ((ledger.entryType === "recharge" || ledger.entryType === "manual_credit") && amount > 0) total.recharge += amount;
    if (ledger.entryType === "usage_debit" && amount < 0) total.usage += Math.abs(amount);
    totals.set(groupId, total);
  }
  return {
    groups: groups.map((group: any) => ({
      groupId: Number(group.id),
      groupName: String(group.name),
      balance: Number(group.balance ?? 0),
      totalRecharge: totals.get(Number(group.id))?.recharge ?? 0,
      totalUsage: totals.get(Number(group.id))?.usage ?? 0,
    })),
    logs: ledgers.map((ledger: any) => ({
      id: Number(ledger.id),
      groupId: Number(ledger.groupId),
      entryType: String(ledger.entryType),
      amount: Number(ledger.amount),
      balanceBefore: Number(ledger.balanceBefore),
      balanceAfter: Number(ledger.balanceAfter),
      actorUserId: ledger.actorUserId == null ? null : Number(ledger.actorUserId),
      usageLedgerId: ledger.usageLedgerId == null ? null : Number(ledger.usageLedgerId),
      reason: String(ledger.reason),
      createdAt: Number(ledger.createdAt),
    })),
  };
}
