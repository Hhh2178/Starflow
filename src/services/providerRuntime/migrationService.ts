import type { ProviderExecutionRequest, ProviderExecutionResult } from "./contracts";
import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { writeAudit } from "@/services/auditLog";

export type MigrationState = "legacy" | "shadow" | "native";

export interface MigrationEvidence {
  modelIdentity: boolean;
  outputContract: boolean;
  tokenUsage: boolean;
  pricingInvariant: boolean;
  reservationInvariant: boolean;
  settlementInvariant: boolean;
  failureReleaseInvariant: boolean;
  controlledAcceptanceId: string;
}

export interface ProviderContractComparison {
  providerId: string;
  modelId: string;
  checks: Pick<MigrationEvidence, "modelIdentity" | "outputContract" | "tokenUsage">;
  compatible: boolean;
}

export interface BillingMigrationSnapshot {
  pricingVersion: number;
  currency: string;
  reservedAmount: number;
  finalAmount: number;
  failureReleasedAmount: number;
}

export function compareBillingSnapshots(legacy: BillingMigrationSnapshot, native: BillingMigrationSnapshot) {
  return {
    pricingInvariant: legacy.pricingVersion === native.pricingVersion && legacy.currency === native.currency,
    reservationInvariant: legacy.reservedAmount === native.reservedAmount,
    settlementInvariant: legacy.finalAmount === native.finalAmount,
    failureReleaseInvariant: legacy.failureReleasedAmount === native.failureReleasedAmount,
  };
}

export class ProviderMigrationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProviderMigrationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenUsage(value: unknown) {
  if (!isObject(value)) return null;
  const input = Number(value.inputTokens ?? value.promptTokens ?? value.prompt_tokens);
  const output = Number(value.outputTokens ?? value.completionTokens ?? value.completion_tokens);
  const total = Number(value.totalTokens ?? value.total_tokens ?? input + output);
  if (![input, output, total].every((item) => Number.isInteger(item) && item >= 0)) return null;
  if (total !== input + output) return null;
  return { input, output, total };
}

function validOutputContract(result: ProviderExecutionResult, capability: ProviderExecutionRequest["capability"]) {
  if (result.kind !== capability || !isObject(result.data)) return false;
  if (capability === "text") return typeof result.data.text === "string" && result.data.text.length > 0;
  if (capability === "json") return true;
  return typeof result.data.value === "string" && result.data.value.length > 0;
}

export function compareProviderContracts(
  request: ProviderExecutionRequest,
  legacy: ProviderExecutionResult,
  native: ProviderExecutionResult,
): ProviderContractComparison {
  const checks = {
    modelIdentity: legacy.diagnostic.providerId === request.providerId
      && native.diagnostic.providerId === request.providerId
      && legacy.diagnostic.modelId === request.modelId
      && native.diagnostic.modelId === request.modelId,
    outputContract: validOutputContract(legacy, request.capability) && validOutputContract(native, request.capability),
    tokenUsage: false,
  };
  const legacyUsage = tokenUsage(legacy.usage);
  const nativeUsage = tokenUsage(native.usage);
  checks.tokenUsage = Boolean(legacyUsage && nativeUsage);
  return { providerId: request.providerId, modelId: request.modelId, checks, compatible: Object.values(checks).every(Boolean) };
}

export function assertControlledTransition(input: {
  providerId: string;
  from: MigrationState;
  to: MigrationState;
  evidence?: MigrationEvidence;
}) {
  if (input.from === input.to || input.to === "legacy") return;
  if (["grsai", "aicopy"].includes(input.providerId)) {
    throw new ProviderMigrationError("ASYNC_CONTRACT_NOT_EQUIVALENT", `${input.providerId} 必须保持 Legacy Bridge，直到异步契约验证完成`);
  }
  if (input.providerId !== "mimo") {
    throw new ProviderMigrationError("PROVIDER_NOT_ALLOWLISTED", "当前阶段只允许迁移 MiMo");
  }
  if (input.to === "native" && input.from !== "shadow") {
    throw new ProviderMigrationError("SHADOW_REQUIRED", "MiMo 必须先经过 shadow 验证");
  }
  if (input.to === "native") {
    const evidence = input.evidence;
    if (!evidence || !evidence.modelIdentity || !evidence.outputContract || !evidence.tokenUsage
      || !evidence.pricingInvariant || !evidence.reservationInvariant || !evidence.settlementInvariant || !evidence.failureReleaseInvariant
      || !evidence.controlledAcceptanceId.trim()) {
      throw new ProviderMigrationError("MIGRATION_EVIDENCE_REQUIRED", "MiMo native 切换需要完整的受控验收证据");
    }
  }
}

export async function applyControlledMigration(input: {
  actor: AuthUser;
  providerId: string;
  expectedRevision: number;
  to: MigrationState;
  evidence?: MigrationEvidence;
}, connection: Knex) {
  if (input.actor.role !== "super_admin") throw new ProviderMigrationError("SUPER_ADMIN_REQUIRED", "仅超级管理员可执行 Provider 迁移");
  return connection.transaction(async (trx) => {
    const current = await trx("o_providerRuntimeProfile").where({ providerId: input.providerId }).first();
    if (!current) throw new ProviderMigrationError("PROVIDER_NOT_FOUND", "Provider 不存在");
    assertControlledTransition({ providerId: input.providerId, from: current.migrationState, to: input.to, evidence: input.evidence });
    if (input.to === "native") {
      const [model, protocol] = await Promise.all([
        trx("o_providerModelProfile").where({ providerId: input.providerId, enabled: 1 }).first(),
        trx("o_providerProtocolProfile").where({ providerId: input.providerId, enabled: 1 }).first(),
      ]);
      if (!model || !protocol) throw new ProviderMigrationError("NATIVE_RUNTIME_NOT_READY", "Native Runtime 需要至少一个已启用模型和协议配置");
    }
    const updated = await trx("o_providerRuntimeProfile").where({ providerId: input.providerId, revision: input.expectedRevision }).update({
      migrationState: input.to,
      adapterId: input.to === "legacy" ? "legacy" : "runtime-kit",
      revision: input.expectedRevision + 1,
      updatedAt: Date.now(),
    });
    if (updated !== 1) throw new ProviderMigrationError("PROVIDER_REVISION_CONFLICT", "Provider 配置已被更新");
    await writeAudit({
      actor: input.actor, groupId: null, action: "admin.provider_runtime.migrate", targetType: "provider", targetId: input.providerId,
      summary: {
        from: String(current.migrationState), to: input.to,
        modelIdentity: input.evidence?.modelIdentity ?? null,
        outputContract: input.evidence?.outputContract ?? null,
        tokenUsage: input.evidence?.tokenUsage ?? null,
        pricingInvariant: input.evidence?.pricingInvariant ?? null,
        reservationInvariant: input.evidence?.reservationInvariant ?? null,
        settlementInvariant: input.evidence?.settlementInvariant ?? null,
        failureReleaseInvariant: input.evidence?.failureReleaseInvariant ?? null,
        controlledAcceptanceId: input.evidence?.controlledAcceptanceId ?? null,
      }, result: "success",
    }, trx);
    return { providerId: input.providerId, from: current.migrationState as MigrationState, to: input.to, revision: input.expectedRevision + 1 };
  });
}
