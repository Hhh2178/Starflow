import assert from "node:assert/strict";
import fs from "node:fs";
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
import { createConfiguredProviderTextRuntime, createProviderTextRuntime } from "@/services/providerRuntime/productionText";
import { prepareMimoRuntimeProfiles } from "@/services/providerRuntime/migrationPreparation";

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
    await db.schema.createTable("o_providerModelProfile", (table) => { table.string("providerId"); table.string("modelId"); table.boolean("enabled"); });
    await db.schema.createTable("o_providerProtocolProfile", (table) => { table.string("providerId"); table.string("protocolType"); table.boolean("enabled"); });
    await db("o_providerRuntimeProfile").insert(["mimo", "grsai", "aicopy"].map((providerId) => ({ providerId, migrationState: "legacy", adapterId: "legacy", revision: 1, updatedAt: 1 })));
    await db("o_providerModelProfile").insert({ providerId: "mimo", modelId: "mimo-v2.5", enabled: 1 });
    await db("o_providerProtocolProfile").insert({ providerId: "mimo", protocolType: "standard", enabled: 1 });
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

test("native transition refuses incomplete runtime model or protocol configuration", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_providerRuntimeProfile", (table) => { table.string("providerId").primary(); table.string("migrationState"); table.string("adapterId"); table.integer("revision"); table.bigInteger("updatedAt"); });
    await db.schema.createTable("o_providerModelProfile", (table) => { table.string("providerId"); table.string("modelId"); table.boolean("enabled"); });
    await db.schema.createTable("o_providerProtocolProfile", (table) => { table.string("providerId"); table.string("protocolType"); table.boolean("enabled"); });
    await db.schema.createTable("o_auditLog", (table) => { table.increments("id"); table.integer("actorUserId"); table.string("actorRole"); table.integer("groupId"); table.string("action"); table.string("targetType"); table.string("targetId"); table.string("targetRole"); table.text("summaryJson"); table.string("result"); table.string("requestId"); table.bigInteger("createdAt"); });
    await db("o_providerRuntimeProfile").insert({ providerId: "mimo", migrationState: "shadow", adapterId: "runtime-kit", revision: 2, updatedAt: 1 });
    await assert.rejects(
      applyControlledMigration({ actor: { id: 1, name: "root", role: "super_admin", groupId: null }, providerId: "mimo", expectedRevision: 2, to: "native", evidence: { modelIdentity: true, outputContract: true, tokenUsage: true, pricingInvariant: true, reservationInvariant: true, settlementInvariant: true, failureReleaseInvariant: true, controlledAcceptanceId: "missing-runtime" } }, db),
      (cause: unknown) => cause instanceof ProviderMigrationError && cause.code === "NATIVE_RUNTIME_NOT_READY",
    );
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

test("production text runtime obeys legacy, shadow and native routing without duplicate calls", async () => {
  let state: "legacy" | "shadow" | "native" = "legacy";
  const calls: string[] = [];
  const runtime = createProviderTextRuntime({
    resolveModel: async () => "mimo:mimo-v2.5",
    resolveRoute: async () => ({ migrationState: state, nativeAdapterId: "runtime-kit" }),
    legacyInvoke: async () => { calls.push("legacy"); return { text: "legacy", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }; },
    nativeExecute: async () => { calls.push("runtime-kit"); return result("runtime-kit", "native", 2, 1); },
  });
  assert.equal((await runtime.invoke("universalAi", { messages: [{ role: "user", content: "ping" }] })).text, "legacy");
  state = "shadow";
  assert.equal((await runtime.invoke("universalAi", { messages: [{ role: "user", content: "ping" }] })).text, "legacy");
  state = "native";
  assert.equal((await runtime.invoke("universalAi", { messages: [{ role: "user", content: "ping" }] })).text, "native");
  assert.deepEqual(calls, ["legacy", "legacy", "runtime-kit"]);
  const comparison = await runtime.compare("universalAi", { messages: [{ role: "user", content: "ping" }] });
  assert.equal(comparison.legacy.diagnostic.adapterId, "legacy");
  assert.equal(comparison.native.diagnostic.adapterId, "runtime-kit");
  assert.deepEqual(calls, ["legacy", "legacy", "runtime-kit", "legacy", "runtime-kit"]);
});

test("native production text runtime executes bounded OpenAI tool calls", async () => {
  const calls: Array<Record<string, any>> = [];
  const executed: unknown[] = [];
  const runtime = createProviderTextRuntime({
    resolveModel: async () => "mimo:mimo-v2.5",
    resolveRoute: async () => ({ migrationState: "native", nativeAdapterId: "runtime-kit" }),
    legacyInvoke: async () => { throw new Error("legacy must not run"); },
    nativeExecute: async (request) => {
      calls.push(request.input as Record<string, any>);
      return calls.length === 1
        ? { ...result("runtime-kit", "", 2, 1), data: { text: "", toolCalls: [{ id: "call-1", name: "record", arguments: { value: "ok" } }] } }
        : result("runtime-kit", "complete", 3, 2);
    },
  });
  const response = await runtime.invoke("universalAi", {
    messages: [{ role: "user", content: "use the tool" }],
    tools: {
      record: {
        description: "record a value",
        inputSchema: { jsonSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
        execute: async (input: unknown) => { executed.push(input); return "recorded"; },
      },
    },
  });
  assert.equal(response.text, "complete");
  assert.deepEqual(executed, [{ value: "ok" }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tools[0].function.name, "record");
  assert.equal(calls[1].messages.at(-1).role, "tool");
  assert.deepEqual(response.usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
});

test("native production text runtime maps AI SDK image parts to OpenAI content", async () => {
  let body: Record<string, any> | undefined;
  const runtime = createProviderTextRuntime({
    resolveModel: async () => "mimo:mimo-v2.5",
    resolveRoute: async () => ({ migrationState: "native", nativeAdapterId: "runtime-kit" }),
    legacyInvoke: async () => { throw new Error("legacy must not run"); },
    nativeExecute: async (request) => { body = request.input as Record<string, any>; return result("runtime-kit", "ok"); },
  });
  await runtime.invoke("universalAi", { messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image", image: "YWJj" }] }] });
  assert.deepEqual(body?.messages[0].content, [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "data:image/png;base64,YWJj" } }]);
});

test("configured production runtime loads versioned profiles and protected credentials", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_setting", (table) => { table.string("key").primary(); table.string("value"); });
    await db.schema.createTable("o_agentDeploy", (table) => { table.string("key").primary(); table.string("modelName"); });
    await db.schema.createTable("o_providerRuntimeProfile", (table) => { table.string("providerId").primary(); table.string("displayName"); table.boolean("enabled"); table.string("migrationState"); table.string("adapterId"); });
    await db.schema.createTable("o_providerModelProfile", (table) => { table.string("providerId"); table.string("modelId"); table.string("displayName"); table.string("capability"); table.string("parameterSchemaJson"); table.boolean("enabled"); });
    await db.schema.createTable("o_providerProtocolProfile", (table) => { table.string("providerId").primary(); table.string("protocolType"); table.string("configJson"); table.boolean("enabled"); });
    await db.schema.createTable("o_vendorConfig", (table) => { table.string("id").primary(); table.text("inputValues"); });
    await db("o_setting").insert({ key: "agentUseMode", value: "0" });
    await db("o_agentDeploy").insert({ key: "universalAi", modelName: "mimo:mimo-v2.5" });
    await db("o_providerRuntimeProfile").insert({ providerId: "mimo", displayName: "MiMo", enabled: 1, migrationState: "native", adapterId: "runtime-kit" });
    await db("o_providerModelProfile").insert({ providerId: "mimo", modelId: "mimo-v2.5", displayName: "MiMo V2.5", capability: "text", parameterSchemaJson: "{}", enabled: 1 });
    await db("o_providerProtocolProfile").insert({ providerId: "mimo", protocolType: "standard", configJson: JSON.stringify({ baseUrl: "https://api.invalid/v1" }), enabled: 1 });
    await db("o_vendorConfig").insert({ id: "mimo", inputValues: JSON.stringify({ apiKey: "test-secret", baseUrl: "https://legacy.invalid/v1" }) });
    const clientOptions: Array<{ baseUrl: string; configured: boolean }> = [];
    const runtime = createConfiguredProviderTextRuntime({
      connection: db,
      legacyInvoke: async () => ({ text: "legacy" }),
      createClient: (options) => {
        clientOptions.push({ baseUrl: options.baseUrl, configured: Boolean(options.apiKey) });
        return {
          request: async () => ({}), createImage: async () => ({}),
          createChatCompletion: async () => ({ choices: [{ message: { content: "native" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }),
        };
      },
    });
    const response = await runtime.invoke("universalAi", { messages: [{ role: "user", content: "ping" }] });
    assert.equal(response.text, "native");
    assert.deepEqual(clientOptions, [{ baseUrl: "https://api.invalid/v1", configured: true }]);
    assert.equal(JSON.stringify(response).includes("test-secret"), false);
  } finally { await db.destroy(); }
});

test("core text queue defaults to the configured Provider Runtime gateway", () => {
  const source = fs.readFileSync("src/jobs/handlers/coreTextExecutor.ts", "utf8");
  assert.match(source, /invokeProviderText/);
  assert.doesNotMatch(source, /invokeText:\s*overrides\.invokeText\s*\?\?\s*\(\(model, input\)\s*=>\s*u\.Ai\.Text\(model\)\.invoke/);
});

test("MiMo runtime preparation is idempotent and stores only a credential reference", async () => {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_vendorConfig", (table) => { table.string("id").primary(); table.text("inputValues"); });
    await db.schema.createTable("o_providerModelProfile", (table) => { table.increments("id"); table.string("providerId"); table.string("modelId"); table.string("displayName"); table.string("capability"); table.string("executionMode"); table.text("inputProfileJson"); table.text("parameterSchemaJson"); table.text("outputMappingJson"); table.boolean("enabled"); table.integer("revision"); table.bigInteger("createdAt"); table.bigInteger("updatedAt"); table.unique(["providerId", "modelId"]); });
    await db.schema.createTable("o_providerProtocolProfile", (table) => { table.increments("id"); table.string("providerId").unique(); table.string("protocolType"); table.text("configJson"); table.boolean("enabled"); table.integer("revision"); table.bigInteger("createdAt"); table.bigInteger("updatedAt"); });
    await db("o_vendorConfig").insert({ id: "mimo", inputValues: JSON.stringify({ apiKey: "never-copy-this", baseUrl: "https://api.invalid/v1" }) });
    const first = await prepareMimoRuntimeProfiles(db, "mimo-v2.5");
    const second = await prepareMimoRuntimeProfiles(db, "mimo-v2.5");
    assert.deepEqual(first, { modelCreated: true, protocolCreated: true, modelId: "mimo-v2.5" });
    assert.deepEqual(second, { modelCreated: false, protocolCreated: false, modelId: "mimo-v2.5" });
    const protocol = await db("o_providerProtocolProfile").where({ providerId: "mimo" }).first();
    assert.deepEqual(JSON.parse(protocol.configJson), { baseUrl: "https://api.invalid/v1", credentialRef: "vendor://mimo/apiKey" });
    assert.equal(protocol.configJson.includes("never-copy-this"), false);
  } finally { await db.destroy(); }
});

test("migration command prepares MiMo profiles before entering shadow", () => {
  const source = fs.readFileSync("scripts/migrateProviderRuntime.ts", "utf8");
  assert.match(source, /prepareMimoRuntimeProfiles/);
  assert.match(source, /providerId\s*===\s*"mimo"\s*&&\s*target\s*===\s*"shadow"/);
});

test("real MiMo validator is opt-in, quota-bounded and writes only sanitized evidence", () => {
  const source = fs.readFileSync("scripts/validateMimoRuntime.ts", "utf8");
  assert.match(source, /MIMO_REAL_VALIDATION/);
  assert.match(source, /MIMO_ACCEPTANCE_SCOPE/);
  assert.match(source, /MIMO_MANUAL_QUOTA_CNY/);
  assert.match(source, /MIMO_MIGRATION_EVIDENCE_FILE/);
  assert.match(source, /compareProviderContracts/);
  assert.match(source, /compareBillingSnapshots/);
  assert.match(source, /os\.tmpdir\(\)/);
  assert.match(source, /process\.exit\(0\)/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(legacy|native)\.(data|text)/i);
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.match(manifest.scripts["validate:mimo"], /validateMimoRuntime\.ts/);
});
