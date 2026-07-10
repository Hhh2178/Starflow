import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { db } from "@/utils/db";
import u from "@/utils";
import { writeAudit } from "@/services/auditLog";

type SettingsConnection = Knex | Knex.Transaction;

export interface VendorDefinition {
  name?: string;
  inputs?: Array<{ key: string; label?: string; type?: string; required?: boolean }>;
  inputValues?: Record<string, unknown>;
  models?: Array<{ name?: string; modelName?: string; type?: string }>;
}

export interface UpdateProviderInput {
  id: string;
  enabled?: boolean;
  inputValues?: Record<string, string>;
}

export interface UpdateAiDeploymentInput {
  id: number;
  vendorId: string | null;
  model: string;
  modelName: string;
  temperature?: number;
  maxOutputTokens?: number;
  disabled: boolean;
}

export class AdminSettingsError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

function requireAdmin(actor: AuthUser): void {
  if (actor.role === "creator") {
    throw new AdminSettingsError(403, "ADMIN_REQUIRED", "仅管理员可以查看全局配置");
  }
}

function requireSuperAdmin(actor: AuthUser): void {
  if (actor.role !== "super_admin") {
    throw new AdminSettingsError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可执行该操作");
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseModels(value: unknown): Array<{ name?: string; modelName?: string; type?: string }> {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function defaultResolveVendor(id: string): VendorDefinition | null {
  try {
    return u.vendor.getVendor(id) ?? null;
  } catch {
    return null;
  }
}

export async function getProviderOverview(
  actor: AuthUser,
  connection: SettingsConnection = db,
  resolveVendor: (id: string) => VendorDefinition | null = defaultResolveVendor,
) {
  requireAdmin(actor);
  const rows = await connection("o_vendorConfig").select("id", "enable", "inputValues", "models").orderBy("id", "asc");
  const providers = rows.map((row) => {
    const id = String(row.id);
    const definition = resolveVendor(id);
    const configuredValues = { ...(definition?.inputValues ?? {}), ...parseObject(row.inputValues) };
    const requiredInputs = (definition?.inputs ?? []).filter((input) => input.required);
    const isConfigured = (key: string) => {
      const value = configuredValues[key];
      return typeof value === "string" ? value.trim().length > 0 : value != null;
    };
    const configured = definition !== null && requiredInputs.every((input) => {
      return isConfigured(input.key);
    });
    const byId = new Map<string, { name: string; type: string }>();
    for (const model of [...(definition?.models ?? []), ...parseModels(row.models)]) {
      const name = String(model.name ?? model.modelName ?? "").trim();
      const type = String(model.type ?? "unknown").trim() || "unknown";
      if (!name) continue;
      byId.set(String(model.modelName ?? name), { name, type });
    }
    const models = [...byId.values()];
    const counts = new Map<string, number>();
    for (const model of models) counts.set(model.type, (counts.get(model.type) ?? 0) + 1);
    return {
      id,
      name: String(definition?.name ?? id),
      enabled: Boolean(row.enable),
      configured,
      inputs: (definition?.inputs ?? []).map((input) => ({
        key: input.key,
        label: String(input.label ?? input.key),
        type: String(input.type ?? "text"),
        required: Boolean(input.required),
        configured: isConfigured(input.key),
      })),
      modelCount: models.length,
      modelTypes: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({ type, count })),
      models,
    };
  });
  return {
    capabilities: { read: true, update: actor.role === "super_admin" },
    providers,
  };
}

export async function updateProvider(
  actor: AuthUser,
  input: UpdateProviderInput,
  connection: Knex = db,
) {
  requireSuperAdmin(actor);
  return connection.transaction(async (trx) => {
    const current = await trx("o_vendorConfig").where({ id: input.id }).first();
    if (!current) throw new AdminSettingsError(404, "PROVIDER_NOT_FOUND", "Provider 不存在");
    const patch: Record<string, unknown> = {};
    const changedFields: string[] = [];
    if (input.enabled !== undefined) {
      patch.enable = input.enabled ? 1 : 0;
      changedFields.push("enabled");
    }
    if (input.inputValues !== undefined) {
      patch.inputValues = JSON.stringify({ ...parseObject(current.inputValues), ...input.inputValues });
      changedFields.push("configuration");
    }
    if (changedFields.length === 0) {
      throw new AdminSettingsError(422, "NO_CHANGES", "没有可更新的 Provider 配置");
    }
    await trx("o_vendorConfig").where({ id: input.id }).update(patch);
    await writeAudit({
      actor,
      groupId: null,
      action: "admin.provider.update",
      targetType: "provider",
      targetId: input.id,
      summary: { changedFields: changedFields.join(",") },
      result: "success",
    }, trx);
    return { id: input.id, updated: true };
  });
}

export async function getAiConfigOverview(actor: AuthUser, connection: SettingsConnection = db) {
  requireAdmin(actor);
  const [setting, rows] = await Promise.all([
    connection("o_setting").where({ key: "agentUseMode" }).select("value").first(),
    connection("o_agentDeploy").select(
      "id", "name", "desc", "vendorId", "model", "modelName",
      "temperature", "maxOutputTokens", "disabled",
    ).orderBy("id", "asc"),
  ]);
  return {
    capabilities: { read: true, update: actor.role === "super_admin" },
    useMode: String(setting?.value ?? "0"),
    deployments: rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? ""),
      description: String(row.desc ?? ""),
      vendorId: row.vendorId == null ? null : String(row.vendorId),
      model: String(row.model ?? ""),
      modelName: String(row.modelName ?? ""),
      temperature: row.temperature == null ? null : Number(row.temperature),
      maxOutputTokens: row.maxOutputTokens == null ? null : Number(row.maxOutputTokens),
      disabled: Boolean(row.disabled),
      configured: Boolean(row.vendorId && row.modelName),
    })),
  };
}

export async function updateAiUseMode(actor: AuthUser, mode: "0" | "1", connection: Knex = db) {
  requireSuperAdmin(actor);
  return connection.transaction(async (trx) => {
    await trx("o_setting").insert({ key: "agentUseMode", value: mode }).onConflict("key").merge({ value: mode });
    await writeAudit({
      actor, groupId: null, action: "admin.ai.use_mode.update", targetType: "ai_config",
      targetId: "agentUseMode", summary: { changedFields: "agentUseMode" }, result: "success",
    }, trx);
    return { agentUseMode: mode };
  });
}

export async function updateAiDeployment(
  actor: AuthUser,
  input: UpdateAiDeploymentInput,
  connection: Knex = db,
) {
  requireSuperAdmin(actor);
  return connection.transaction(async (trx) => {
    const deployment = await trx("o_agentDeploy").where({ id: input.id }).first();
    if (!deployment) throw new AdminSettingsError(404, "AI_DEPLOYMENT_NOT_FOUND", "AI 部署配置不存在");
    if (input.vendorId && !(await trx("o_vendorConfig").where({ id: input.vendorId }).first())) {
      throw new AdminSettingsError(404, "PROVIDER_NOT_FOUND", "Provider 不存在");
    }
    const patch = {
      vendorId: input.vendorId,
      model: input.model,
      modelName: input.modelName,
      temperature: input.temperature ?? deployment.temperature,
      maxOutputTokens: input.maxOutputTokens ?? deployment.maxOutputTokens,
      disabled: input.disabled ? 1 : 0,
    };
    await trx("o_agentDeploy").where({ id: input.id }).update(patch);
    await writeAudit({
      actor, groupId: null, action: "admin.ai.deployment.update", targetType: "ai_deployment",
      targetId: input.id, summary: { changedFields: Object.keys(patch).join(",") }, result: "success",
    }, trx);
    return { id: input.id, updated: true };
  });
}

async function getTableNames(connection: SettingsConnection): Promise<string[]> {
  const client = String(connection.client.config.client);
  if (client.includes("sqlite") || client.includes("better-sqlite3")) {
    const rows = await connection("sqlite_master")
      .where({ type: "table" })
      .whereNot("name", "like", "sqlite_%")
      .select("name")
      .orderBy("name", "asc");
    return rows.map((row) => String(row.name));
  }
  const rows = await connection("information_schema.tables")
    .where({ table_schema: "public", table_type: "BASE TABLE" })
    .select({ name: "table_name" })
    .orderBy("table_name", "asc");
  return rows.map((row) => String(row.name));
}

export async function getSystemOverview(actor: AuthUser, connection: SettingsConnection = db) {
  requireSuperAdmin(actor);
  const [setting, tableNames] = await Promise.all([
    connection("o_setting").where({ key: "switchAiDevTool" }).select("value").first(),
    getTableNames(connection),
  ]);
  const tables = await Promise.all(tableNames.map(async (name) => {
    const result = await connection(name).count({ count: "*" }).first();
    return { name, rowCount: Number(result?.count ?? 0) };
  }));
  return {
    database: { tables },
    development: { aiDevToolsEnabled: setting?.value === "1" },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      environment: process.env.NODE_ENV ?? "unknown",
      uptimeSeconds: Math.floor(process.uptime()),
    },
    capabilities: {
      updateDevelopment: true,
      clearDatabase: false,
      importDatabase: false,
      exportDatabase: false,
    },
  };
}

export async function updateDevelopmentSettings(actor: AuthUser, enabled: boolean, connection: Knex = db) {
  requireSuperAdmin(actor);
  return connection.transaction(async (trx) => {
    const value = enabled ? "1" : "0";
    await trx("o_setting").insert({ key: "switchAiDevTool", value }).onConflict("key").merge({ value });
    await writeAudit({
      actor, groupId: null, action: "admin.system.development.update", targetType: "system_setting",
      targetId: "switchAiDevTool", summary: { changedFields: "aiDevToolsEnabled" }, result: "success",
    }, trx);
    return { aiDevToolsEnabled: enabled };
  });
}
