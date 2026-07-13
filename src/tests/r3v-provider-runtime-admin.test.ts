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
  listRuntimeTestHistory,
  ProviderRuntimeAdminError,
  runRuntimeTest,
  updateRuntimeModel,
  updateRuntimeProvider,
  upsertRuntimeProtocol,
} from "@/services/providerRuntime/adminService";

const superAdmin: AuthUser = { id: 1, name: "root", role: "super_admin", groupId: null };
const admin: AuthUser = { id: 2, name: "admin", role: "admin", groupId: 1 };

async function main() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, true);
    await assert.rejects(createRuntimeProvider(admin, { providerId: "native-test", displayName: "Native Test", enabled: true, migrationState: "native", adapterId: "runtime-kit" }, db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.code === "SUPER_ADMIN_REQUIRED");
    assert.deepEqual(await createRuntimeProvider(superAdmin, { providerId: "native-test", displayName: "Native Test", enabled: true, migrationState: "native", adapterId: "runtime-kit" }, db), { providerId: "native-test", revision: 1 });
    assert.equal(JSON.parse((await db("o_vendorConfig").where({ id: "native-test" }).first()).inputValues).apiKey, undefined);
    await updateRuntimeProvider(superAdmin, "native-test", 1, { displayName: "Native Updated" }, db);
    await assert.rejects(updateRuntimeProvider(superAdmin, "native-test", 1, { enabled: false }, db), /updated|更新/);

    await createRuntimeModel(superAdmin, { providerId: "native-test", modelId: "chat-a", displayName: "Chat A", capability: "text", executionMode: "sync", parameterSchema: { prompt: { type: "string" } }, enabled: true }, db);
    await createRuntimeModel(superAdmin, { providerId: "native-test", modelId: "image-a", displayName: "Image A", capability: "image", executionMode: "background_poll", enabled: false }, db);
    assert.equal((await listRuntimeProviders(admin, db)).some((item) => item.providerId === "native-test" && item.modelCount === 2), true);
    await updateRuntimeModel(superAdmin, "native-test", "chat-a", 1, { displayName: "Chat Updated" }, db);
    const filtered = await listRuntimeModels(superAdmin, { page: 1, pageSize: 10, query: "chat", capability: "text", enabled: true, executionMode: "sync" }, db);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].displayName, "Chat Updated");

    await upsertRuntimeProtocol(superAdmin, { providerId: "native-test", protocolType: "standard", config: { baseUrl: "https://api.invalid/v1", credentialRef: "secret://provider/native-test" }, enabled: true }, db);
    await assert.rejects(upsertRuntimeProtocol(superAdmin, { providerId: "native-test", protocolType: "standard", config: { apiKey: "sk-must-not-store" }, enabled: true, expectedRevision: 1 }, db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.code === "INLINE_CREDENTIAL_FORBIDDEN");

    await assert.rejects(runRuntimeTest(superAdmin, { providerId: "native-test", modelId: "chat-a", testType: "generation" }, async () => undefined, db), (cause: unknown) => cause instanceof ProviderRuntimeAdminError && cause.code === "BILLABLE_CONFIRMATION_REQUIRED");
    await runRuntimeTest(superAdmin, { providerId: "native-test", modelId: "chat-a", testType: "connection" }, async () => undefined, db);
    await assert.rejects(runRuntimeTest(superAdmin, { providerId: "native-test", modelId: "chat-a", testType: "generation", confirmBillable: true }, async () => { throw Object.assign(new Error("Bearer sk-secret signed=https://secret.invalid"), { code: "UPSTREAM_FAILED" }); }, db), /测试失败/);
    const history = await listRuntimeTestHistory(superAdmin, "native-test", db);
    assert.equal(history.length, 2);
    assert.equal(JSON.stringify(history).includes("sk-secret"), false);
    assert.deepEqual(new Set(history.map((row) => row.testType)), new Set(["connection", "generation"]));

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
    console.log("R3V Provider Runtime administration tests passed");
  } finally {
    await db.destroy();
  }
}

main().then(() => process.exit(0), (cause) => { console.error(cause); process.exit(1); });
