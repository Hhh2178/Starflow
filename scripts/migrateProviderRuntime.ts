import fs from "node:fs/promises";
import path from "node:path";
import knex from "knex";
import getPath from "@/utils/getPath";
import { applyControlledMigration, type MigrationEvidence, type MigrationState } from "@/services/providerRuntime/migrationService";

const databasePath = process.env.STARS_DATABASE_FILE?.trim()
  ? path.resolve(process.env.STARS_DATABASE_FILE.trim())
  : getPath(process.env.STARS_ACCEPTANCE_MODE === "1" ? "acceptance.sqlite" : "db2.sqlite");
const db = knex({ client: "better-sqlite3", connection: { filename: databasePath }, useNullAsDefault: true });

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function migrationState(value: string | undefined): MigrationState {
  if (value === "legacy" || value === "shadow" || value === "native") return value;
  throw new Error("--to must be legacy, shadow, or native");
}

async function evidence(): Promise<MigrationEvidence | undefined> {
  const path = process.env.PROVIDER_MIGRATION_EVIDENCE_FILE?.trim();
  if (!path) return undefined;
  const value = JSON.parse(await fs.readFile(path, "utf8")) as Partial<MigrationEvidence>;
  const booleanKeys = ["modelIdentity", "outputContract", "tokenUsage", "pricingInvariant", "reservationInvariant", "settlementInvariant", "failureReleaseInvariant"] as const;
  if (!booleanKeys.every((key) => value[key] === true) || typeof value.controlledAcceptanceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.controlledAcceptanceId)) {
    throw new Error("migration evidence is incomplete or invalid");
  }
  return value as MigrationEvidence;
}

async function validateCurrentState() {
  const rows = await db("o_providerRuntimeProfile").select("providerId", "migrationState", "adapterId", "revision").orderBy("providerId");
  const protectedProviders = rows.filter((row) => ["grsai", "aicopy"].includes(row.providerId));
  if (protectedProviders.some((row) => row.migrationState !== "legacy" || row.adapterId !== "legacy")) throw new Error("GRSAI and AICopy must remain on Legacy Bridge");
  if (rows.some((row) => row.migrationState !== "legacy" && row.providerId !== "mimo")) throw new Error("only MiMo may leave legacy during Stage 8");
  const counts = Object.fromEntries(["legacy", "shadow", "native"].map((state) => [state, rows.filter((row) => row.migrationState === state).length]));
  console.log(JSON.stringify({ ok: true, providers: rows.length, counts, protectedLegacy: protectedProviders.map((row) => row.providerId).sort() }));
}

async function main() {
  if (!(await db.schema.hasTable("o_providerRuntimeProfile"))) throw new Error("Provider Runtime migration table is missing; run application migrations first");
  const providerId = argument("--provider");
  const targetRaw = argument("--to");
  if (!providerId && !targetRaw) return validateCurrentState();
  if (!providerId || !targetRaw) throw new Error("--provider and --to are required together");
  if (process.env.PROVIDER_MIGRATION_APPLY !== "1") throw new Error("set PROVIDER_MIGRATION_APPLY=1 for an explicit state change");
  const current = await db("o_providerRuntimeProfile").where({ providerId }).first();
  if (!current) throw new Error("Provider not found");
  const actor = await db("o_user").where({ role: "super_admin" }).orderBy("id").first();
  if (!actor) throw new Error("Super Admin actor not found");
  const result = await applyControlledMigration({
    actor: { id: actor.id, name: actor.name, role: "super_admin", groupId: null },
    providerId, expectedRevision: current.revision, to: migrationState(targetRaw), evidence: await evidence(),
  }, db);
  console.log(JSON.stringify({ ok: true, providerId: result.providerId, from: result.from, to: result.to, revision: result.revision }));
}

main().then(async () => { await db.destroy(); }, async (cause) => {
  console.error(cause instanceof Error ? cause.message : "Provider migration failed");
  await db.destroy();
  process.exit(1);
});
