import assert from "node:assert/strict";
import knex, { type Knex } from "knex";
import initDB from "@/lib/initDB";
import { migrateProviderRuntimeProfiles } from "@/lib/fixDB";
import {
  createProviderModelProfile,
  ProviderProfileError,
  updateProviderRuntimeProfile,
} from "@/services/providerRuntime/profileService";

const runtimeTables = [
  "o_providerRuntimeProfile",
  "o_providerModelProfile",
  "o_providerProtocolProfile",
  "o_providerTestRun",
  "o_runningHubDescriptor",
] as const;

async function columns(db: Knex, table: string): Promise<Set<string>> {
  const rows = await db.raw(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row: { name: string }) => row.name));
}

async function expectProfileError(operation: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(operation, (cause: unknown) => {
    assert.equal(cause instanceof ProviderProfileError, true);
    const error = cause as ProviderProfileError;
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

async function testFreshSchema(db: Knex): Promise<void> {
  await initDB(db, false, true);
  for (const table of runtimeTables) {
    assert.equal(await db.schema.hasTable(table), true, `${table} must exist`);
  }

  const providerColumns = await columns(db, "o_providerRuntimeProfile");
  for (const column of ["providerId", "displayName", "enabled", "migrationState", "adapterId", "revision", "createdAt", "updatedAt"]) {
    assert.equal(providerColumns.has(column), true, `provider profile missing ${column}`);
  }
  for (const forbidden of ["apiKey", "credentials", "inputValues", "secret"]) {
    assert.equal(providerColumns.has(forbidden), false, `provider profile must not contain ${forbidden}`);
  }

  const modelColumns = await columns(db, "o_providerModelProfile");
  for (const column of ["providerId", "modelId", "displayName", "capability", "executionMode", "parameterSchemaJson", "enabled", "revision", "createdAt", "updatedAt"]) {
    assert.equal(modelColumns.has(column), true, `model profile missing ${column}`);
  }
  const protocolColumns = await columns(db, "o_providerProtocolProfile");
  for (const column of ["providerId", "protocolType", "configJson", "enabled", "revision", "createdAt", "updatedAt"]) {
    assert.equal(protocolColumns.has(column), true, `protocol profile missing ${column}`);
  }
  const descriptorColumns = await columns(db, "o_runningHubDescriptor");
  for (const column of ["providerId", "modelId", "resourceType", "resourceId", "inputMappingJson", "uploadMappingJson", "outputRuleJson", "enabled", "revision", "createdAt", "updatedAt"]) {
    assert.equal(descriptorColumns.has(column), true, `RunningHub descriptor missing ${column}`);
  }

  const vendors = await db("o_vendorConfig").select("id", "enable", "models").orderBy("id");
  const profiles = await db("o_providerRuntimeProfile").select("*").orderBy("providerId");
  assert.equal(profiles.length, vendors.length);
  for (const vendor of vendors) {
    const profile = profiles.find((item) => item.providerId === vendor.id);
    assert.ok(profile, `missing legacy profile for ${vendor.id}`);
    assert.equal(profile.migrationState, "legacy");
    assert.equal(profile.enabled, vendor.enable);
    assert.equal(profile.revision, 1);
    assert.equal((await db("o_vendorConfig").where({ id: vendor.id }).first()).models, vendor.models);
  }

  await assert.rejects(db("o_providerRuntimeProfile").insert({
    providerId: vendors[0].id,
    displayName: vendors[0].id,
    enabled: 0,
    migrationState: "legacy",
    adapterId: "legacy",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

async function testProfileService(db: Knex): Promise<void> {
  await expectProfileError(createProviderModelProfile({
    providerId: "missing-provider",
    modelId: "missing-model",
    displayName: "Missing Model",
    capability: "text",
    executionMode: "sync",
  }, db), 422, "PROVIDER_NOT_FOUND");

  const provider = await db("o_providerRuntimeProfile").orderBy("providerId").first();
  const created = await createProviderModelProfile({
    providerId: provider.providerId,
    modelId: "text-alpha",
    displayName: "Text Alpha",
    capability: "text",
    executionMode: "sync",
  }, db);
  assert.equal(created.revision, 1);
  await expectProfileError(createProviderModelProfile({
    providerId: provider.providerId,
    modelId: "text-alpha",
    displayName: "Duplicate",
    capability: "text",
    executionMode: "sync",
  }, db), 409, "PROVIDER_MODEL_CONFLICT");

  const updated = await updateProviderRuntimeProfile(provider.providerId, 1, { displayName: "Updated Provider" }, db);
  assert.equal(updated.revision, 2);
  assert.equal(updated.displayName, "Updated Provider");
  await expectProfileError(
    updateProviderRuntimeProfile(provider.providerId, 1, { enabled: false }, db),
    409,
    "PROVIDER_REVISION_CONFLICT",
  );
}

async function testLegacyMigration(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    await db("o_vendorConfig").insert([
      { id: "legacy-a", inputValues: JSON.stringify({ apiKey: "must-stay-here" }), models: "[]", enable: 1 },
      { id: "legacy-b", inputValues: "{}", models: JSON.stringify([{ modelName: "b" }]), enable: 0 },
    ]);

    await migrateProviderRuntimeProfiles(db);
    await migrateProviderRuntimeProfiles(db);
    const profiles = await db("o_providerRuntimeProfile").select("*").orderBy("providerId");
    assert.equal(profiles.length, 2);
    assert.deepEqual(profiles.map((item) => [item.providerId, item.enabled, item.migrationState]), [
      ["legacy-a", 1, "legacy"],
      ["legacy-b", 0, "legacy"],
    ]);
    assert.equal(JSON.parse((await db("o_vendorConfig").where({ id: "legacy-a" }).first()).inputValues).apiKey, "must-stay-here");
    assert.equal((await db("o_vendorConfig").where({ id: "legacy-b" }).first()).models, JSON.stringify([{ modelName: "b" }]));
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await testFreshSchema(db);
    await testProfileService(db);
  } finally {
    await db.destroy();
  }
  await testLegacyMigration();
  console.log("R3S provider runtime profile tests passed");
}

main().then(
  () => process.exit(0),
  (cause) => {
    console.error(cause);
    process.exit(1);
  },
);
