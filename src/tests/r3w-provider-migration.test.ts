import assert from "node:assert/strict";
import test from "node:test";
import knex from "knex";
import { ProviderRuntimeGateway } from "@/services/providerRuntime/gateway";
import { ProviderRuntimeRegistry } from "@/services/providerRuntime/registry";
import type { ProviderExecutionRequest, ProviderExecutionResult } from "@/services/providerRuntime/contracts";
import {
  assertControlledTransition,
  applyControlledMigration,
  compareBillingSnapshots,
  compareProviderContracts,
  ProviderMigrationError,
} from "@/services/providerRuntime/migrationService";

const request: ProviderExecutionRequest = { providerId: "mimo", modelId: "mimo-v2.5", capability: "text", input: { prompt: "ping" }, timeoutMs: 1_000 };
const result = (adapterId: string, text: string, inputTokens = 5, outputTokens = 3): ProviderExecutionResult => ({
  kind: "text", data: { text }, usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  diagnostic: { adapterId, providerId: "mimo", modelId: "mimo-v2.5" },
});

test("controlled migration writes revisioned redacted audit evidence and supports rollback", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_providerRuntimeProfile", (table) => {
      table.string("providerId").primary(); table.string("migrationState").notNullable(); table.string("adapterId").notNullable(); table.integer("revision").notNullable(); table.bigInteger("updatedAt").notNullable();
    });
    await db.schema.createTable("o_auditLog", (table) => {
      table.increments("id"); table.integer("actorUserId"); table.string("actorRole"); table.integer("groupId"); table.string("action"); table.string("targetType"); table.string("targetId"); table.string("targetRole"); table.text("summaryJson"); table.string("result"); table.string("requestId"); table.bigInteger("createdAt");
    });
    await db("o_providerRuntimeProfile").insert(["mimo", "grsai", "aicopy"].map((providerId) => ({ providerId, migrationState: "legacy", adapterId: "legacy", revision: 1, updatedAt: 1 })));
    const actor = { id: 1, name: "root", role: "super_admin" as const, groupId: null };
    const initial = await db("o_providerRuntimeProfile").where({ providerId: "mimo" }).first();
    const shadow = await applyControlledMigration({ actor, providerId: "mimo", expectedRevision: initial.revision, to: "shadow" }, db);
    const native = await applyControlledMigration({ actor, providerId: "mimo", expectedRevision: shadow.revision, to: "native", evidence: { modelIdentity: true, outputContract: true, tokenUsage: true, pricingInvariant: true, reservationInvariant: true, settlementInvariant: true, failureReleaseInvariant: true, controlledAcceptanceId: "acceptance-r3w" } }, db);
    assert.equal((await db("o_providerRuntimeProfile").where({ providerId: "mimo" }).first()).adapterId, "runtime-kit");
    const audits = await db("o_auditLog").where({ action: "admin.provider_runtime.migrate", targetId: "mimo" }).orderBy("id");
    assert.equal(audits.length, 2);
    assert.equal(audits.some((row) => JSON.parse(row.summaryJson).controlledAcceptanceId === "acceptance-r3w"), true);
    assert.equal(JSON.stringify(audits).includes("apiKey"), false);
    await applyControlledMigration({ actor, providerId: "mimo", expectedRevision: native.revision, to: "legacy" }, db);
    assert.deepEqual(await db("o_providerRuntimeProfile").whereIn("providerId", ["grsai", "aicopy"]).select("migrationState"), [{ migrationState: "legacy" }, { migrationState: "legacy" }]);
  } finally { await db.destroy(); }
});

test("shadow production traffic remains Legacy-only and cannot duplicate a billable request", async () => {
  const calls: string[] = [];
  const registry = new ProviderRuntimeRegistry();
  registry.register({ id: "legacy", supports: () => true, execute: async () => { calls.push("legacy"); return result("legacy", "legacy response"); } });
  registry.register({ id: "runtime-kit", supports: () => true, execute: async () => { calls.push("runtime-kit"); return result("runtime-kit", "native response"); } });
  const gateway = new ProviderRuntimeGateway(registry, { resolve: async () => ({ migrationState: "shadow", nativeAdapterId: "runtime-kit" }) });
  assert.equal((await gateway.execute(request)).diagnostic.adapterId, "legacy");
  assert.deepEqual(calls, ["legacy"]);
});

test("MiMo comparison proves identity, normalized text contract and Token usage", () => {
  const comparison = compareProviderContracts(request, result("legacy", "legacy response"), result("runtime-kit", "native response"));
  assert.deepEqual(comparison.checks, { modelIdentity: true, outputContract: true, tokenUsage: true });
  assert.equal(comparison.compatible, true);
  assert.equal(JSON.stringify(comparison).includes("legacy response"), false);
  assert.equal(JSON.stringify(comparison).includes("native response"), false);
  assert.equal(compareProviderContracts(request, result("legacy", "ok"), result("runtime-kit", "ok", 5, 4)).compatible, false);
});

test("adapter migration evidence preserves pricing, reservation, settlement and failure release", () => {
  const snapshot = { pricingVersion: 2, currency: "CNY", reservedAmount: 0.05, finalAmount: 0.008, failureReleasedAmount: 0.05 };
  assert.deepEqual(compareBillingSnapshots(snapshot, { ...snapshot }), { pricingInvariant: true, reservationInvariant: true, settlementInvariant: true, failureReleaseInvariant: true });
  assert.equal(compareBillingSnapshots(snapshot, { ...snapshot, finalAmount: 0.009 }).settlementInvariant, false);
});

test("controlled transition requires MiMo shadow evidence and pins async Providers to Legacy", () => {
  assert.doesNotThrow(() => assertControlledTransition({ providerId: "mimo", from: "legacy", to: "shadow" }));
  assert.throws(() => assertControlledTransition({ providerId: "mimo", from: "legacy", to: "native" }), (cause: unknown) => cause instanceof ProviderMigrationError && cause.code === "SHADOW_REQUIRED");
  assert.throws(() => assertControlledTransition({ providerId: "mimo", from: "shadow", to: "native" }), (cause: unknown) => cause instanceof ProviderMigrationError && cause.code === "MIGRATION_EVIDENCE_REQUIRED");
  assert.doesNotThrow(() => assertControlledTransition({ providerId: "mimo", from: "shadow", to: "native", evidence: { modelIdentity: true, outputContract: true, tokenUsage: true, pricingInvariant: true, reservationInvariant: true, settlementInvariant: true, failureReleaseInvariant: true, controlledAcceptanceId: "local-non-production" } }));
  for (const providerId of ["grsai", "aicopy"]) {
    assert.throws(() => assertControlledTransition({ providerId, from: "legacy", to: "shadow" }), (cause: unknown) => cause instanceof ProviderMigrationError && cause.code === "ASYNC_CONTRACT_NOT_EQUIVALENT");
  }
});
