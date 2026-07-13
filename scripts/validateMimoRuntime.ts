import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import knex from "knex";
import getPath from "@/utils/getPath";
import type { BillingUnits } from "@/types/generationQueue";
import { calculateActualCost, calculateReservedCost, getActivePricingSnapshot } from "@/services/modelPricing";
import { compareBillingSnapshots, compareProviderContracts } from "@/services/providerRuntime/migrationService";
import { createConfiguredProviderTextRuntime } from "@/services/providerRuntime/productionText";
import type { ProviderExecutionRequest, ProviderExecutionResult } from "@/services/providerRuntime/contracts";

const databasePath = process.env.STARS_DATABASE_FILE?.trim()
  ? path.resolve(process.env.STARS_DATABASE_FILE.trim())
  : getPath("db2.sqlite");
const db = knex({ client: "better-sqlite3", connection: { filename: databasePath }, useNullAsDefault: true });

function manualQuota() {
  const value = Number(process.env.MIMO_MANUAL_QUOTA_CNY);
  if (!Number.isFinite(value) || value <= 0 || value > 0.2) throw new Error("MIMO_MANUAL_QUOTA_CNY must be greater than 0 and no more than 0.2");
  return value;
}

function units(result: ProviderExecutionResult): BillingUnits {
  const usage = result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : {};
  const inputTokens = Number(usage.inputTokens ?? usage.promptTokens);
  const outputTokens = Number(usage.outputTokens ?? usage.completionTokens);
  return {
    requests: 1,
    ...(Number.isInteger(inputTokens) && inputTokens >= 0 ? { inputTokens } : {}),
    ...(Number.isInteger(outputTokens) && outputTokens >= 0 ? { outputTokens } : {}),
  };
}

async function main() {
  if (process.env.MIMO_REAL_VALIDATION !== "1") {
    console.log("MiMo real validation skipped; set MIMO_REAL_VALIDATION=1 explicitly.");
    return;
  }
  if (process.env.MIMO_ACCEPTANCE_SCOPE !== "non-production") throw new Error("MIMO_ACCEPTANCE_SCOPE must be non-production");
  const quota = manualQuota();
  const mode = process.env.MIMO_VALIDATION_MODE === "native-smoke" ? "native-smoke" : "comparison";
  const modelId = process.env.MIMO_VALIDATION_MODEL?.trim() || "mimo-v2.5";
  const profile = await db("o_providerRuntimeProfile").where({ providerId: "mimo" }).first();
  const expectedState = mode === "comparison" ? "shadow" : "native";
  if (profile?.migrationState !== expectedState) throw new Error(`MiMo must be ${expectedState} for ${mode}`);
  const runtime = createConfiguredProviderTextRuntime({
    connection: db,
    legacyInvoke: async (model, input) => {
      const { default: Ai } = await import("@/utils/ai");
      return await Ai.Text(model, false).invoke(input as any) as any;
    },
  });
  const input = {
    messages: [{ role: "user", content: "请只回复：OK" }],
    temperature: 0,
    maxOutputTokens: 256,
  };
  if (mode === "native-smoke") {
    const response = await runtime.invoke(`mimo:${modelId}`, input);
    if (!response.text.trim() || response.diagnostic?.adapterId !== "runtime-kit") throw new Error("MiMo native smoke did not return a normalized Runtime Kit text result");
    console.log(JSON.stringify({ ok: true, scope: "non-production", mode, manualQuotaCny: quota, adapter: "runtime-kit", outputContract: true }));
    return;
  }
  const evidencePath = process.env.MIMO_MIGRATION_EVIDENCE_FILE?.trim();
  if (!evidencePath) throw new Error("MIMO_MIGRATION_EVIDENCE_FILE is required for comparison mode");
  const compared = await runtime.compare(`mimo:${modelId}`, input);
  const request: ProviderExecutionRequest = { providerId: "mimo", modelId, capability: "text", input: {}, timeoutMs: 120_000 };
  const contract = compareProviderContracts(request, compared.legacy, compared.native);
  const pricing = await getActivePricingSnapshot({ providerId: "mimo", modelId, canonicalModel: `mimo:${modelId}` }, "text", db);
  const reservedAmount = calculateReservedCost(pricing, { requests: 1 });
  const legacyBilling = { pricingVersion: pricing.version, currency: pricing.currency, reservedAmount, finalAmount: calculateActualCost(pricing, units(compared.legacy)), failureReleasedAmount: reservedAmount };
  const nativeBilling = { pricingVersion: pricing.version, currency: pricing.currency, reservedAmount, finalAmount: calculateActualCost(pricing, units(compared.native)), failureReleasedAmount: reservedAmount };
  const billing = compareBillingSnapshots(legacyBilling, nativeBilling);
  const checks = { ...contract.checks, ...billing };
  if (!Object.values(checks).every(Boolean)) {
    const legacyTextPresent = typeof (compared.legacy.data as Record<string, unknown>)?.text === "string"
      && String((compared.legacy.data as Record<string, unknown>).text).trim().length > 0;
    const nativeTextPresent = typeof (compared.native.data as Record<string, unknown>)?.text === "string"
      && String((compared.native.data as Record<string, unknown>).text).trim().length > 0;
    console.error(JSON.stringify({ ok: false, checks, diagnostics: { legacyTextPresent, nativeTextPresent } }));
    throw new Error("MiMo controlled comparison failed");
  }
  const controlledAcceptanceId = `mimo-stage8-${Date.now()}`;
  const evidence = { ...checks, controlledAcceptanceId };
  const resolvedEvidencePath = path.resolve(evidencePath);
  const relativeToTemp = path.relative(os.tmpdir(), resolvedEvidencePath);
  if (relativeToTemp.startsWith("..") || path.isAbsolute(relativeToTemp)) throw new Error("MiMo evidence file must stay in the operating-system temporary directory outside Git");
  await fs.mkdir(path.dirname(resolvedEvidencePath), { recursive: true });
  await fs.writeFile(resolvedEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, scope: "non-production", mode, manualQuotaCny: quota, checks, controlledAcceptanceId }));
}

main().then(async () => { await db.destroy(); process.exit(0); }, async () => {
  console.error("MiMo controlled validation failed; no prompt, output, URL or credential was logged.");
  await db.destroy();
  process.exit(1);
});
