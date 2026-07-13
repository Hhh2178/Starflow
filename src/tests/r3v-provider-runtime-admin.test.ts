import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import type { AuthUser } from "@/types/auth";
import {
  createRuntimeModel,
  createRuntimeProvider,
  deleteRuntimeModel,
  deleteRuntimeProvider,
  listRuntimeModels,
  listRuntimeProviders,
  getRuntimeProtocol,
  listRuntimeTestHistory,
  ProviderRuntimeAdminError,
  runRuntimeTest,
  updateRuntimeModel,
  updateRuntimeProvider,
  upsertRuntimeProtocol,
} from "@/services/providerRuntime/adminService";
import {
  clearProviderCredential,
  getProviderCredentialStatus,
  probeProviderConnection,
  probeProviderDraft,
  replaceProviderCredential,
} from "@/services/providerRuntime/providerCredentials";

const superAdmin: AuthUser = { id: 1, name: "root", role: "super_admin", groupId: null };
const admin: AuthUser = { id: 2, name: "admin", role: "admin", groupId: 1 };

async function main() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, true);
    await assert.rejects(createRuntimeProvider(admin, { providerId: "native-test", displayName: "Native Test", enabled: true, migrationState: "legacy", adapterId: "legacy" }, db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.code === "SUPER_ADMIN_REQUIRED");
    await assert.rejects(createRuntimeProvider(superAdmin, { providerId: "unsafe-native", displayName: "Unsafe Native", enabled: true, migrationState: "native", adapterId: "runtime-kit" }, db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.code === "PROVIDER_MUST_START_LEGACY");
    assert.deepEqual(await createRuntimeProvider(superAdmin, { providerId: "native-test", displayName: "Native Test", enabled: true, migrationState: "legacy", adapterId: "legacy" }, db), { providerId: "native-test", revision: 1 });
    assert.equal(JSON.parse((await db("o_vendorConfig").where({ id: "native-test" }).first()).inputValues).apiKey, undefined);
    await updateRuntimeProvider(superAdmin, "native-test", 1, {
      displayName: "Native Updated",
      note: "用于文本与图像任务",
      advancedConfig: { request: { method: "post", fixedBody: { region: "cn" } } },
    }, db);
    await assert.rejects(updateRuntimeProvider(superAdmin, "native-test", 1, { enabled: false }, db), /updated|更新/);

    await assert.rejects(replaceProviderCredential(admin, "native-test", "ordinary-admin-secret", db), /SUPER_ADMIN_REQUIRED|超级管理员/);
    const testCredential = "test-secret-value-1234";
    await replaceProviderCredential(superAdmin, "native-test", testCredential, db);
    const credentialStatus = await getProviderCredentialStatus(superAdmin, "native-test", db);
    assert.equal(credentialStatus.configured, true);
    assert.equal(credentialStatus.preview, "****1234");
    assert.equal(typeof credentialStatus.updatedAt, "number");
    assert.equal(JSON.stringify(credentialStatus).includes(testCredential), false);
    await assert.rejects(updateRuntimeProvider(superAdmin, "native-test", 2, {
      advancedConfig: { request: { headers: { Authorization: "must-not-store" } } },
    }, db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.status === 422 && cause.code === "ADVANCED_CONFIG_INVALID");

    let draftProbeUrl = "";
    const draftCredential = "draft-secret-value-5678";
    const draftProbe = await probeProviderDraft(superAdmin, {
      baseUrl: "https://draft-provider.invalid/v1",
      credential: draftCredential,
      protocolType: "standard",
    }, db, async (url) => {
      draftProbeUrl = String(url);
      return new Response(null, { status: 200 });
    });
    assert.equal(draftProbeUrl, "https://draft-provider.invalid/v1/models");
    assert.equal(draftProbe.status, "available");
    assert.equal(JSON.stringify(draftProbe).includes(draftCredential), false);
    assert.equal(JSON.parse((await db("o_vendorConfig").where({ id: "native-test" }).first()).inputValues).apiKey, testCredential);

    await createRuntimeModel(superAdmin, { providerId: "native-test", modelId: "chat-a", displayName: "Chat A", capability: "text", executionMode: "sync", inputProfile: { prompt: true }, parameterSchema: { prompt: { type: "string" } }, outputMapping: { text: "choices.0.message.content" }, enabled: true }, db);
    await createRuntimeModel(superAdmin, { providerId: "native-test", modelId: "image-a", displayName: "Image A", capability: "image", executionMode: "background_poll", enabled: false }, db);
    const providers = await listRuntimeProviders(admin, db);
    const runtimeProvider = providers.find((item) => item.providerId === "native-test");
    assert.equal(runtimeProvider?.modelCount, 2);
    assert.equal(runtimeProvider?.note, "用于文本与图像任务");
    assert.deepEqual(runtimeProvider?.advancedConfig, { request: { method: "POST", fixedBody: { region: "cn" } } });
    assert.equal(runtimeProvider?.credential.configured, true);
    assert.equal(JSON.stringify(runtimeProvider).includes(testCredential), false);
    await updateRuntimeModel(superAdmin, "native-test", "chat-a", 1, { displayName: "Chat Updated" }, db);
    const filtered = await listRuntimeModels(superAdmin, { page: 1, pageSize: 10, providerId: "native-test", query: "chat", capability: "text", enabled: true, executionMode: "sync" }, db);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].displayName, "Chat Updated");
    assert.deepEqual(filtered.items[0].inputProfile, { prompt: true });
    assert.deepEqual(filtered.items[0].outputMapping, { text: "choices.0.message.content" });

    await upsertRuntimeProtocol(superAdmin, { providerId: "native-test", protocolType: "standard", config: { baseUrl: "https://api.invalid/v1", credentialRef: "secret://provider/native-test" }, enabled: true }, db);
    assert.deepEqual(await getRuntimeProtocol(admin, "native-test", db), { providerId: "native-test", protocolType: "standard", config: { baseUrl: "https://api.invalid/v1" }, enabled: true, revision: 1 });
    await assert.rejects(upsertRuntimeProtocol(superAdmin, { providerId: "native-test", protocolType: "standard", config: { apiKey: "sk-must-not-store" }, enabled: true, expectedRevision: 1 }, db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.code === "INLINE_CREDENTIAL_FORBIDDEN");
    const savedProbe = await probeProviderConnection(superAdmin, "native-test", db, async () => new Response(null, { status: 204 }));
    assert.equal(savedProbe.status, "available");
    assert.equal(JSON.stringify(savedProbe).includes(testCredential), false);

    await assert.rejects(runRuntimeTest(superAdmin, { providerId: "native-test", modelId: "chat-a", testType: "generation" }, async () => undefined, db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.code === "BILLABLE_CONFIRMATION_REQUIRED");
    await runRuntimeTest(superAdmin, { providerId: "native-test", modelId: "chat-a", testType: "connection" }, async () => undefined, db);
    await assert.rejects(runRuntimeTest(superAdmin, { providerId: "native-test", modelId: "chat-a", testType: "generation", confirmBillable: true }, async () => { throw Object.assign(new Error("Bearer sk-secret signed=https://secret.invalid"), { code: "UPSTREAM_FAILED" }); }, db), /测试失败/);
    const history = await listRuntimeTestHistory(superAdmin, "native-test", db);
    assert.equal(history.length, 2);
    assert.equal(JSON.stringify(history).includes("sk-secret"), false);
    assert.deepEqual(new Set(history.map((row) => row.testType)), new Set(["connection", "generation"]));

    await clearProviderCredential(superAdmin, "native-test", db);
    assert.deepEqual(await getProviderCredentialStatus(superAdmin, "native-test", db), {
      configured: false,
      preview: null,
      updatedAt: null,
    });

    const deployment = await db("o_agentDeploy").first();
    await db("o_agentDeploy").where({ id: deployment.id }).update({ vendorId: "native-test", modelName: "chat-a" });
    await assert.rejects(deleteRuntimeModel(superAdmin, "native-test", "chat-a", db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.code === "MODEL_IN_USE");
    await db("o_agentDeploy").where({ id: deployment.id }).update({ vendorId: null, modelName: "" });
    await deleteRuntimeModel(superAdmin, "native-test", "chat-a", db);
    await deleteRuntimeProvider(superAdmin, "native-test", db);
    assert.equal(await db("o_providerRuntimeProfile").where({ providerId: "native-test" }).first(), undefined);

    const audits = await db("o_auditLog").whereLike("action", "admin.provider_runtime.%").select("summaryJson");
    assert.ok(audits.length >= 8);
    const auditText = JSON.stringify(audits);
    assert.equal(/sk-must-not-store|sk-secret|secret:\/\//.test(auditText), false);
    assert.equal(auditText.includes(testCredential) || auditText.includes(draftCredential), false);
    console.log("R3V Provider Runtime administration tests passed");
  } finally {
    await db.destroy();
  }
}

main().then(() => process.exit(0), (cause) => { console.error(cause); process.exit(1); });
