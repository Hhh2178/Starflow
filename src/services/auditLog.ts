import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
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
]);

type AuditScalar = string | number | boolean | null;

function sanitizeSummary(summary: Record<string, AuditScalar>): Record<string, AuditScalar> {
  const sanitized: Record<string, AuditScalar> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (!SUMMARY_KEYS.has(key)) continue;
    if (value === null || ["number", "boolean"].includes(typeof value)) sanitized[key] = value;
    if (typeof value === "string") {
      sanitized[key] = /password|passwordHash|apiKey|token/i.test(value) ? "[redacted]" : value;
    }
  }
  return sanitized;
}

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
  connection: Knex | Knex.Transaction = db,
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
