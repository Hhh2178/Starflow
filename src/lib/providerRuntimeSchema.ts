import type { Knex } from "knex";

interface RuntimeTableSchema {
  name: string;
  builder: (table: Knex.CreateTableBuilder) => void;
  initData?: (knex: Knex) => Promise<void>;
}

const now = () => Date.now();

export async function seedLegacyProviderProfiles(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("o_vendorConfig")) || !(await knex.schema.hasTable("o_providerRuntimeProfile"))) return;
  const vendors = await knex("o_vendorConfig").select("id", "enable");
  const existing = new Set(await knex("o_providerRuntimeProfile").pluck("providerId"));
  const createdAt = now();
  const missing = vendors
    .filter((vendor) => !existing.has(vendor.id))
    .map((vendor) => ({
      providerId: String(vendor.id),
      displayName: String(vendor.id),
      enabled: vendor.enable ? 1 : 0,
      migrationState: "legacy",
      adapterId: "legacy",
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    }));
  if (missing.length > 0) await knex("o_providerRuntimeProfile").insert(missing);
}

export const providerRuntimeTableSchemas: RuntimeTableSchema[] = [
  {
    name: "o_providerRuntimeProfile",
    builder: (table) => {
      table.increments("id").primary();
      table.text("providerId").notNullable().unique();
      table.text("displayName").notNullable();
      table.boolean("enabled").notNullable().defaultTo(false);
      table.text("migrationState").notNullable().defaultTo("legacy");
      table.text("adapterId").notNullable().defaultTo("legacy");
      table.integer("revision").notNullable().defaultTo(1);
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
    },
    initData: seedLegacyProviderProfiles,
  },
  {
    name: "o_providerModelProfile",
    builder: (table) => {
      table.increments("id").primary();
      table.text("providerId").notNullable().index();
      table.text("modelId").notNullable();
      table.text("displayName").notNullable();
      table.text("capability").notNullable();
      table.text("executionMode").notNullable();
      table.text("inputProfileJson").notNullable().defaultTo("{}");
      table.text("parameterSchemaJson").notNullable().defaultTo("{}");
      table.text("outputMappingJson").notNullable().defaultTo("{}");
      table.boolean("enabled").notNullable().defaultTo(true);
      table.integer("revision").notNullable().defaultTo(1);
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
      table.unique(["providerId", "modelId"]);
    },
  },
  {
    name: "o_providerProtocolProfile",
    builder: (table) => {
      table.increments("id").primary();
      table.text("providerId").notNullable().unique();
      table.text("protocolType").notNullable();
      table.text("configJson").notNullable().defaultTo("{}");
      table.boolean("enabled").notNullable().defaultTo(true);
      table.integer("revision").notNullable().defaultTo(1);
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
    },
  },
  {
    name: "o_providerTestRun",
    builder: (table) => {
      table.increments("id").primary();
      table.text("providerId").notNullable().index();
      table.text("modelId");
      table.text("testType").notNullable();
      table.text("status").notNullable();
      table.integer("durationMs");
      table.text("errorCode");
      table.integer("createdAt").notNullable();
    },
  },
  {
    name: "o_runningHubDescriptor",
    builder: (table) => {
      table.increments("id").primary();
      table.text("providerId").notNullable().index();
      table.text("modelId").notNullable();
      table.text("resourceType").notNullable();
      table.text("resourceId").notNullable();
      table.text("inputMappingJson").notNullable().defaultTo("{}");
      table.text("uploadMappingJson").notNullable().defaultTo("{}");
      table.text("outputRuleJson").notNullable().defaultTo("{}");
      table.integer("pollingIntervalMs").notNullable().defaultTo(3000);
      table.integer("timeoutMs").notNullable().defaultTo(600000);
      table.boolean("enabled").notNullable().defaultTo(true);
      table.integer("revision").notNullable().defaultTo(1);
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
      table.unique(["providerId", "modelId"]);
    },
  },
];

export async function ensureProviderRuntimeSchema(knex: Knex): Promise<void> {
  for (const table of providerRuntimeTableSchemas) {
    if (!(await knex.schema.hasTable(table.name))) await knex.schema.createTable(table.name, table.builder);
  }
  await seedLegacyProviderProfiles(knex);
}
