import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import knex, { type Knex } from "knex";
import initDB from "@/lib/initDB";
import {
  AdminSettingsError,
  getAiConfigOverview,
  getProviderOverview,
  getSystemOverview,
  updateAiDeployment,
  updateAiUseMode,
  updateDevelopmentSettings,
  updateProvider,
  type VendorDefinition,
} from "@/services/adminSettings";
import { createProviderOverviewRouter } from "@/routes/admin/providers/getOverview";
import { createUpdateProviderRouter } from "@/routes/admin/providers/updateProvider";
import { createAiConfigOverviewRouter } from "@/routes/admin/ai-config/getOverview";
import { createUpdateDeploymentRouter } from "@/routes/admin/ai-config/updateDeployment";
import { createUpdateUseModeRouter } from "@/routes/admin/ai-config/updateUseMode";
import { createSystemOverviewRouter } from "@/routes/admin/system/getOverview";
import { createUpdateDevelopmentRouter } from "@/routes/admin/system/updateDevelopment";
import type { AuthUser } from "@/types/auth";

const actors = {
  superAdmin: { id: 1, name: "root", role: "super_admin", groupId: null },
  admin: { id: 2, name: "admin", role: "admin", groupId: 101 },
  creator: { id: 3, name: "creator", role: "creator", groupId: 101 },
} satisfies Record<string, AuthUser>;

const definitions: Record<string, VendorDefinition> = {
  secureVendor: {
    name: "Secure Vendor",
    inputs: [
      { key: "apiKey", label: "API Key", type: "password", required: true },
      { key: "baseUrl", label: "Base URL", type: "url", required: true },
    ],
    models: [
      { name: "Text Alpha", modelName: "text-alpha", type: "text" },
      { name: "Image Alpha", modelName: "image-alpha", type: "image" },
    ],
  },
};

const resolveVendor = (id: string) => definitions[id] ?? null;

async function seed(db: Knex): Promise<void> {
  await db("o_auditLog").del();
  await db("o_vendorConfig").insert({
    id: "secureVendor",
    enable: 1,
    inputValues: JSON.stringify({ apiKey: "provider-secret", baseUrl: "https://provider.invalid" }),
    models: JSON.stringify([{ name: "Video Beta", modelName: "video-beta", type: "video" }]),
  });
  await db("o_setting").insert({ key: "agentUseMode", value: "0" });
  await db("o_agentDeploy").insert({
    id: 9001,
    key: "productionAgent:test",
    name: "Test Agent",
    desc: "Test deployment",
    vendorId: "secureVendor",
    model: "Text Alpha",
    modelName: "text-alpha",
    temperature: 0.7,
    maxOutputTokens: 2048,
    disabled: 0,
  });
}

async function expectSettingsError(operation: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(operation, (cause: unknown) => {
    assert.equal(cause instanceof AdminSettingsError, true);
    const error = cause as AdminSettingsError;
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

function assertNoSecrets(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of ["provider-secret", "rotated-secret", "inputValues", "credentials"]) {
    assert.equal(serialized.includes(forbidden), false, `response leaked ${forbidden}`);
  }
}

async function testServices(db: Knex): Promise<void> {
  const superProviders = await getProviderOverview(actors.superAdmin, db, resolveVendor);
  const adminProviders = await getProviderOverview(actors.admin, db, resolveVendor);
  assert.deepEqual(adminProviders.providers, superProviders.providers);
  assert.deepEqual(superProviders.providers, [{
    id: "secureVendor",
    name: "Secure Vendor",
    enabled: true,
    configured: true,
    inputs: [
      { key: "apiKey", label: "API Key", type: "password", required: true, configured: true },
      { key: "baseUrl", label: "Base URL", type: "url", required: true, configured: true },
    ],
    modelCount: 3,
    modelTypes: [
      { type: "image", count: 1 },
      { type: "text", count: 1 },
      { type: "video", count: 1 },
    ],
    models: [
      { name: "Text Alpha", type: "text" },
      { name: "Image Alpha", type: "image" },
      { name: "Video Beta", type: "video" },
    ],
  }]);
  assert.deepEqual(superProviders.capabilities, { read: true, update: true });
  assert.deepEqual(adminProviders.capabilities, { read: true, update: false });
  assert.equal("code" in superProviders.providers[0], false);
  assert.equal("inputValues" in superProviders.providers[0], false);
  assertNoSecrets(superProviders);

  await db("o_vendorConfig").insert({ id: "missingDefinition", enable: 1, inputValues: "{}", models: "[]" });
  const unknownProvider = (await getProviderOverview(actors.admin, db, resolveVendor)).providers
    .find((provider) => provider.id === "missingDefinition");
  assert.equal(unknownProvider?.configured, false);
  assert.deepEqual(unknownProvider?.inputs, []);

  const aiOverview = await getAiConfigOverview(actors.admin, db);
  assert.equal(aiOverview.useMode, "0");
  assert.deepEqual(aiOverview.capabilities, { read: true, update: false });
  assert.deepEqual(aiOverview.deployments.find((item) => item.id === 9001), {
    id: 9001,
    name: "Test Agent",
    description: "Test deployment",
    vendorId: "secureVendor",
    model: "Text Alpha",
    modelName: "text-alpha",
    temperature: 0.7,
    maxOutputTokens: 2048,
    disabled: false,
    configured: true,
  });
  assertNoSecrets(aiOverview);

  await expectSettingsError(getProviderOverview(actors.creator, db, resolveVendor), 403, "ADMIN_REQUIRED");
  await expectSettingsError(updateProvider(actors.admin, {
    id: "secureVendor",
    enabled: true,
    inputValues: { apiKey: "rotated-secret" },
  }, db), 403, "SUPER_ADMIN_REQUIRED");
  await expectSettingsError(updateAiUseMode(actors.admin, "1", db), 403, "SUPER_ADMIN_REQUIRED");
  await expectSettingsError(getSystemOverview(actors.admin, db), 403, "SUPER_ADMIN_REQUIRED");
  await expectSettingsError(updateDevelopmentSettings(actors.admin, true, db), 403, "SUPER_ADMIN_REQUIRED");

  await updateProvider(actors.superAdmin, {
    id: "secureVendor",
    enabled: true,
    inputValues: { apiKey: "rotated-secret" },
  }, db);
  const storedInputs = JSON.parse((await db("o_vendorConfig").where({ id: "secureVendor" }).first()).inputValues);
  assert.equal(storedInputs.apiKey, "rotated-secret");
  assert.equal(storedInputs.baseUrl, "https://provider.invalid");

  await updateAiUseMode(actors.superAdmin, "1", db);
  await updateAiDeployment(actors.superAdmin, {
    id: 9001,
    vendorId: "secureVendor",
    model: "Image Alpha",
    modelName: "image-alpha",
    temperature: 0.3,
    maxOutputTokens: 4096,
    disabled: false,
  }, db);
  const updatedAi = await getAiConfigOverview(actors.superAdmin, db);
  assert.equal(updatedAi.useMode, "1");
  assert.equal(updatedAi.deployments.find((item) => item.id === 9001)?.modelName, "image-alpha");

  const system = await getSystemOverview(actors.superAdmin, db);
  assert.equal(system.development.aiDevToolsEnabled, false);
  assert.equal(system.database.tables.some((table) => table.name === "o_vendorConfig" && table.rowCount >= 1), true);
  assert.deepEqual(system.capabilities, {
    updateDevelopment: true,
    clearDatabase: false,
    importDatabase: false,
    exportDatabase: false,
  });
  assert.equal(typeof system.runtime.nodeVersion, "string");
  assertNoSecrets(system);

  await updateDevelopmentSettings(actors.superAdmin, true, db);
  assert.equal((await getSystemOverview(actors.superAdmin, db)).development.aiDevToolsEnabled, true);

  const audits = await db("o_auditLog")
    .whereIn("action", ["admin.provider.update", "admin.ai.use_mode.update", "admin.ai.deployment.update", "admin.system.development.update"])
    .select("action", "summaryJson");
  assert.equal(audits.length, 4);
  assertNoSecrets(audits);
  assert.equal(audits.every((item) => !JSON.parse(item.summaryJson).apiKey), true);
}

async function requestJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function testRoutes(db: Knex): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const key = String(req.headers["x-test-actor"] ?? "superAdmin") as keyof typeof actors;
    (req as any).user = actors[key];
    next();
  });
  app.use("/api/admin/providers/getOverview", createProviderOverviewRouter((actor) => getProviderOverview(actor, db, resolveVendor)));
  app.use("/api/admin/providers/updateProvider", createUpdateProviderRouter((actor, input) => updateProvider(actor, input, db)));
  app.use("/api/admin/ai-config/getOverview", createAiConfigOverviewRouter((actor) => getAiConfigOverview(actor, db)));
  app.use("/api/admin/ai-config/updateDeployment", createUpdateDeploymentRouter((actor, input) => updateAiDeployment(actor, input, db)));
  app.use("/api/admin/ai-config/updateUseMode", createUpdateUseModeRouter((actor, mode) => updateAiUseMode(actor, mode, db)));
  app.use("/api/admin/system/getOverview", createSystemOverviewRouter((actor) => getSystemOverview(actor, db)));
  app.use("/api/admin/system/updateDevelopment", createUpdateDevelopmentRouter((actor, enabled) => updateDevelopmentSettings(actor, enabled, db)));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/admin`;
    for (const path of ["/providers/getOverview", "/ai-config/getOverview"]) {
      const response = await requestJson(`${base}${path}`, { headers: { "x-test-actor": "admin" } });
      assert.equal(response.status, 200);
      assertNoSecrets(response.body);
    }
    const adminSystem = await requestJson(`${base}/system/getOverview`, { headers: { "x-test-actor": "admin" } });
    assert.equal(adminSystem.status, 403);
    assert.equal(adminSystem.body.data.code, "SUPER_ADMIN_REQUIRED");

    const writes: Array<[string, unknown]> = [
      ["/providers/updateProvider", { id: "secureVendor", enabled: false, inputValues: { apiKey: "rotated-secret" } }],
      ["/ai-config/updateUseMode", { agentUseMode: "0" }],
      ["/ai-config/updateDeployment", { id: 9001, vendorId: "secureVendor", model: "Text Alpha", modelName: "text-alpha", disabled: false }],
      ["/system/updateDevelopment", { aiDevToolsEnabled: false }],
    ];
    for (const [path, payload] of writes) {
      const response = await requestJson(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-actor": "admin" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.data.code, "SUPER_ADMIN_REQUIRED");
      assertNoSecrets(response.body);
    }

    const invalid = await requestJson(`${base}/system/updateDevelopment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiDevToolsEnabled: "yes", extra: true }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function main(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, false);
    await seed(db);
    await testServices(db);
    await testRoutes(db);
    console.log("R3L admin settings tests passed");
  } finally {
    await db.destroy();
  }
}

main().then(
  () => process.exit(0),
  (cause) => {
    console.error(cause);
    process.exit(1);
  },
);
