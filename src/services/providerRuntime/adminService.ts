import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { db } from "@/utils/db";
import { writeAudit } from "@/services/auditLog";
import { ProviderProfileError } from "./profileService";

export class ProviderRuntimeAdminError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ProviderRuntimeAdminError";
  }
}

export interface ProviderInput { providerId: string; displayName: string; enabled: boolean; migrationState: "legacy" | "shadow" | "native"; adapterId: string }
export interface ModelInput { providerId: string; modelId: string; displayName: string; capability: "text" | "image" | "video" | "audio" | "json"; executionMode: "sync" | "background_poll" | "webhook" | "runninghub" | "legacy"; inputProfile?: Record<string, unknown>; parameterSchema?: Record<string, unknown>; outputMapping?: Record<string, unknown>; enabled: boolean }
export interface ProtocolInput { providerId: string; protocolType: "standard" | "poll" | "webhook" | "runninghub" | "legacy"; config: Record<string, unknown>; enabled: boolean; expectedRevision?: number }

function requireSuperAdmin(actor: AuthUser) {
  if (actor.role !== "super_admin") throw new ProviderRuntimeAdminError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可管理 Provider Runtime");
}

function requireAdmin(actor: AuthUser) {
  if (actor.role === "creator") throw new ProviderRuntimeAdminError(403, "ADMIN_REQUIRED", "仅管理员可查看 Provider Runtime");
}

function cleanId(value: string, field: string) {
  const result = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) throw new ProviderRuntimeAdminError(422, `${field.toUpperCase()}_INVALID`, `${field} 格式无效`);
  return result;
}

function safeConfig(config: Record<string, unknown>) {
  const serialized = JSON.stringify(config);
  if (/"(?:apiKey|secret|token|password|authorization)"\s*:/i.test(serialized)) throw new ProviderRuntimeAdminError(422, "INLINE_CREDENTIAL_FORBIDDEN", "协议配置只能保存凭据引用，不能保存密钥值");
  return serialized;
}

async function audit(actor: AuthUser, action: string, targetType: string, targetId: string, summary: Record<string, string | number | boolean | null>, connection: Knex) {
  await writeAudit({ actor, groupId: null, action, targetType, targetId, summary, result: "success" }, connection);
}

export async function createRuntimeProvider(actor: AuthUser, input: ProviderInput, connection: Knex = db) {
  requireSuperAdmin(actor);
  const providerId = cleanId(input.providerId, "providerId");
  if (!input.displayName.trim() || !input.adapterId.trim()) throw new ProviderRuntimeAdminError(422, "PROVIDER_FIELDS_REQUIRED", "显示名和适配器不能为空");
  return connection.transaction(async (trx) => {
    if (await trx("o_providerRuntimeProfile").where({ providerId }).first()) throw new ProviderRuntimeAdminError(409, "PROVIDER_CONFLICT", "Provider 已存在");
    const timestamp = Date.now();
    await trx("o_providerRuntimeProfile").insert({ providerId, displayName: input.displayName.trim(), enabled: input.enabled ? 1 : 0, migrationState: input.migrationState, adapterId: input.adapterId.trim(), revision: 1, createdAt: timestamp, updatedAt: timestamp });
    if (!(await trx("o_vendorConfig").where({ id: providerId }).first())) await trx("o_vendorConfig").insert({ id: providerId, inputValues: "{}", models: "[]", enable: input.enabled ? 1 : 0 });
    await audit(actor, "admin.provider_runtime.create", "provider", providerId, { migrationState: input.migrationState, adapterId: input.adapterId }, trx);
    return { providerId, revision: 1 };
  });
}

export async function updateRuntimeProvider(actor: AuthUser, providerIdRaw: string, expectedRevision: number, patch: Partial<Omit<ProviderInput, "providerId">>, connection: Knex = db) {
  requireSuperAdmin(actor);
  const providerId = cleanId(providerIdRaw, "providerId");
  return connection.transaction(async (trx) => {
    const current = await trx("o_providerRuntimeProfile").where({ providerId }).first();
    if (!current) throw new ProviderRuntimeAdminError(404, "PROVIDER_NOT_FOUND", "Provider 不存在");
    const update: Record<string, unknown> = { revision: expectedRevision + 1, updatedAt: Date.now() };
    for (const field of ["displayName", "migrationState", "adapterId"] as const) if (patch[field] !== undefined) update[field] = String(patch[field]).trim();
    if (patch.enabled !== undefined) update.enabled = patch.enabled ? 1 : 0;
    if (await trx("o_providerRuntimeProfile").where({ providerId, revision: expectedRevision }).update(update) !== 1) throw new ProviderProfileError(409, "PROVIDER_REVISION_CONFLICT", "Provider 配置已被更新");
    if (patch.enabled !== undefined) await trx("o_vendorConfig").where({ id: providerId }).update({ enable: patch.enabled ? 1 : 0 });
    await audit(actor, "admin.provider_runtime.update", "provider", providerId, { expectedRevision, changedFields: Object.keys(patch).sort().join(",") }, trx);
    return { providerId, revision: expectedRevision + 1 };
  });
}

export async function createRuntimeModel(actor: AuthUser, input: ModelInput, connection: Knex = db) {
  requireSuperAdmin(actor);
  const providerId = cleanId(input.providerId, "providerId");
  const modelId = cleanId(input.modelId, "modelId");
  return connection.transaction(async (trx) => {
    if (!(await trx("o_providerRuntimeProfile").where({ providerId }).first())) throw new ProviderRuntimeAdminError(422, "PROVIDER_NOT_FOUND", "Provider 不存在");
    if (await trx("o_providerModelProfile").where({ providerId, modelId }).first()) throw new ProviderRuntimeAdminError(409, "MODEL_CONFLICT", "模型已存在");
    const timestamp = Date.now();
    await trx("o_providerModelProfile").insert({ providerId, modelId, displayName: input.displayName.trim(), capability: input.capability, executionMode: input.executionMode, inputProfileJson: JSON.stringify(input.inputProfile ?? {}), parameterSchemaJson: JSON.stringify(input.parameterSchema ?? {}), outputMappingJson: JSON.stringify(input.outputMapping ?? {}), enabled: input.enabled ? 1 : 0, revision: 1, createdAt: timestamp, updatedAt: timestamp });
    await audit(actor, "admin.provider_runtime.model.create", "provider_model", `${providerId}:${modelId}`, { capability: input.capability, executionMode: input.executionMode }, trx);
    return { providerId, modelId, revision: 1 };
  });
}

export async function updateRuntimeModel(actor: AuthUser, providerIdRaw: string, modelIdRaw: string, expectedRevision: number, patch: Partial<Omit<ModelInput, "providerId" | "modelId">>, connection: Knex = db) {
  requireSuperAdmin(actor);
  const providerId = cleanId(providerIdRaw, "providerId"), modelId = cleanId(modelIdRaw, "modelId");
  return connection.transaction(async (trx) => {
    const current = await trx("o_providerModelProfile").where({ providerId, modelId }).first();
    if (!current) throw new ProviderRuntimeAdminError(404, "MODEL_NOT_FOUND", "模型不存在");
    const update: Record<string, unknown> = { revision: expectedRevision + 1, updatedAt: Date.now() };
    for (const field of ["displayName", "capability", "executionMode"] as const) if (patch[field] !== undefined) update[field] = String(patch[field]).trim();
    if (patch.parameterSchema !== undefined) update.parameterSchemaJson = JSON.stringify(patch.parameterSchema);
    if (patch.inputProfile !== undefined) update.inputProfileJson = JSON.stringify(patch.inputProfile);
    if (patch.outputMapping !== undefined) update.outputMappingJson = JSON.stringify(patch.outputMapping);
    if (patch.enabled !== undefined) update.enabled = patch.enabled ? 1 : 0;
    if (await trx("o_providerModelProfile").where({ providerId, modelId, revision: expectedRevision }).update(update) !== 1) throw new ProviderRuntimeAdminError(409, "MODEL_REVISION_CONFLICT", "模型配置已被更新");
    await audit(actor, "admin.provider_runtime.model.update", "provider_model", `${providerId}:${modelId}`, { expectedRevision, changedFields: Object.keys(patch).sort().join(",") }, trx);
    return { providerId, modelId, revision: expectedRevision + 1 };
  });
}

export async function listRuntimeModels(actor: AuthUser, input: { page?: number; pageSize?: number; providerId?: string; query?: string; capability?: string; enabled?: boolean; executionMode?: string } = {}, connection: Knex = db) {
  requireAdmin(actor);
  const page = input.page ?? 1, pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ProviderRuntimeAdminError(422, "PAGINATION_INVALID", "分页参数无效");
  const apply = (query: Knex.QueryBuilder) => {
    if (input.providerId) query.where({ providerId: input.providerId });
    if (input.query) query.where((builder) => builder.whereLike("modelId", `%${input.query}%`).orWhereLike("displayName", `%${input.query}%`).orWhereLike("providerId", `%${input.query}%`));
    if (input.capability) query.where({ capability: input.capability });
    if (input.enabled !== undefined) query.where({ enabled: input.enabled ? 1 : 0 });
    if (input.executionMode) query.where({ executionMode: input.executionMode });
    return query;
  };
  const [{ count }, rows] = await Promise.all([apply(connection("o_providerModelProfile").clone()).count({ count: "id" }).first() as any, apply(connection("o_providerModelProfile").clone()).select("providerId", "modelId", "displayName", "capability", "executionMode", "inputProfileJson", "parameterSchemaJson", "outputMappingJson", "enabled", "revision").orderBy(["providerId", "modelId"]).limit(pageSize).offset((page - 1) * pageSize)]);
  const parse = (value: unknown) => { try { return JSON.parse(typeof value === "string" ? value : "{}"); } catch { return {}; } };
  return { page, pageSize, total: Number(count), items: rows.map((row: any) => ({ providerId: row.providerId, modelId: row.modelId, displayName: row.displayName, capability: row.capability, executionMode: row.executionMode, inputProfile: parse(row.inputProfileJson), parameterSchema: parse(row.parameterSchemaJson), outputMapping: parse(row.outputMappingJson), enabled: Boolean(row.enabled), revision: Number(row.revision) })) };
}

export async function listRuntimeProviders(actor: AuthUser, connection: Knex = db) {
  requireAdmin(actor);
  const rows = await connection("o_providerRuntimeProfile as provider")
    .leftJoin("o_providerProtocolProfile as protocol", "protocol.providerId", "provider.providerId")
    .select("provider.providerId", "provider.displayName", "provider.enabled", "provider.migrationState", "provider.adapterId", "provider.revision", "protocol.protocolType", "protocol.enabled as protocolEnabled")
    .orderBy("provider.displayName");
  const counts = await connection("o_providerModelProfile").select("providerId").count({ count: "id" }).groupBy("providerId");
  const countByProvider = new Map(counts.map((row: any) => [String(row.providerId), Number(row.count)]));
  return rows.map((row) => ({ ...row, enabled: Boolean(row.enabled), protocolEnabled: row.protocolEnabled == null ? null : Boolean(row.protocolEnabled), modelCount: countByProvider.get(String(row.providerId)) ?? 0 }));
}

async function modelReferences(connection: Knex, providerId: string, modelId: string) {
  const canonical = `${providerId}:${modelId}`;
  const [projects, deployments, prices, jobs] = await Promise.all([
    connection("o_project").whereIn("imageModel", [modelId, canonical]).orWhereIn("videoModel", [modelId, canonical]).count({ count: "id" }).first(),
    connection("o_agentDeploy").where({ vendorId: providerId, modelName: modelId }).count({ count: "id" }).first(),
    connection("o_modelPricing").where({ providerId, modelId, status: "active" }).count({ count: "id" }).first(),
    connection("o_generationJob").whereIn("status", ["queued", "running"]).andWhereLike("payloadJson", `%${providerId}%`).andWhereLike("payloadJson", `%${modelId}%`).count({ count: "id" }).first(),
  ]);
  return { projects: Number(projects?.count ?? 0), deployments: Number(deployments?.count ?? 0), activePrices: Number(prices?.count ?? 0), nonterminalJobs: Number(jobs?.count ?? 0) };
}

export async function deleteRuntimeModel(actor: AuthUser, providerIdRaw: string, modelIdRaw: string, connection: Knex = db) {
  requireSuperAdmin(actor);
  const providerId = cleanId(providerIdRaw, "providerId"), modelId = cleanId(modelIdRaw, "modelId");
  return connection.transaction(async (trx) => {
    if (!(await trx("o_providerModelProfile").where({ providerId, modelId }).first())) throw new ProviderRuntimeAdminError(404, "MODEL_NOT_FOUND", "模型不存在");
    const references = await modelReferences(trx, providerId, modelId);
    if (Object.values(references).some(Boolean)) throw new ProviderRuntimeAdminError(409, "MODEL_IN_USE", `模型仍被引用：${JSON.stringify(references)}`);
    await trx("o_providerModelProfile").where({ providerId, modelId }).delete();
    await audit(actor, "admin.provider_runtime.model.delete", "provider_model", `${providerId}:${modelId}`, { deleted: true }, trx);
    return { deleted: true };
  });
}

export async function deleteRuntimeProvider(actor: AuthUser, providerIdRaw: string, connection: Knex = db) {
  requireSuperAdmin(actor);
  const providerId = cleanId(providerIdRaw, "providerId");
  return connection.transaction(async (trx) => {
    if (!(await trx("o_providerRuntimeProfile").where({ providerId }).first())) throw new ProviderRuntimeAdminError(404, "PROVIDER_NOT_FOUND", "Provider 不存在");
    const models = await trx("o_providerModelProfile").where({ providerId }).select("modelId");
    for (const model of models) {
      const references = await modelReferences(trx, providerId, String(model.modelId));
      if (Object.values(references).some(Boolean)) throw new ProviderRuntimeAdminError(409, "PROVIDER_IN_USE", `Provider 模型仍被引用：${model.modelId}`);
    }
    await trx("o_runningHubDescriptor").where({ providerId }).delete();
    await trx("o_providerProtocolProfile").where({ providerId }).delete();
    await trx("o_providerModelProfile").where({ providerId }).delete();
    await trx("o_providerRuntimeProfile").where({ providerId }).delete();
    await trx("o_vendorConfig").where({ id: providerId }).delete();
    await audit(actor, "admin.provider_runtime.delete", "provider", providerId, { deleted: true, modelCount: models.length }, trx);
    return { deleted: true };
  });
}

export async function upsertRuntimeProtocol(actor: AuthUser, input: ProtocolInput, connection: Knex = db) {
  requireSuperAdmin(actor);
  const providerId = cleanId(input.providerId, "providerId");
  return connection.transaction(async (trx) => {
    const current = await trx("o_providerProtocolProfile").where({ providerId }).first();
    const timestamp = Date.now();
    if (current && input.expectedRevision !== current.revision) throw new ProviderRuntimeAdminError(409, "PROTOCOL_REVISION_CONFLICT", "协议配置已被更新");
    const row = { protocolType: input.protocolType, configJson: safeConfig(input.config), enabled: input.enabled ? 1 : 0, revision: current ? current.revision + 1 : 1, updatedAt: timestamp };
    if (current) await trx("o_providerProtocolProfile").where({ providerId }).update(row); else await trx("o_providerProtocolProfile").insert({ providerId, ...row, createdAt: timestamp });
    await audit(actor, "admin.provider_runtime.protocol.upsert", "provider_protocol", providerId, { protocolType: input.protocolType, revision: row.revision }, trx);
    return { providerId, revision: row.revision };
  });
}

function sanitizeProtocolConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeProtocolConfig);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !/(credential|secret|api.?key|token|password|authorization)/i.test(key)).map(([key, item]) => [key, sanitizeProtocolConfig(item)]));
}

export async function getRuntimeProtocol(actor: AuthUser, providerId: string, connection: Knex = db) {
  requireAdmin(actor);
  const row = await connection("o_providerProtocolProfile").where({ providerId }).first();
  if (!row) return null;
  let config: unknown = {};
  try { config = JSON.parse(row.configJson ?? "{}"); } catch { config = {}; }
  return { providerId, protocolType: row.protocolType, config: sanitizeProtocolConfig(config), enabled: Boolean(row.enabled), revision: Number(row.revision) };
}

export async function runRuntimeTest(actor: AuthUser, input: { providerId: string; modelId?: string; testType: "connection" | "generation"; confirmBillable?: boolean }, executor: () => Promise<unknown>, connection: Knex = db) {
  requireSuperAdmin(actor);
  if (input.testType === "generation" && input.confirmBillable !== true) throw new ProviderRuntimeAdminError(422, "BILLABLE_CONFIRMATION_REQUIRED", "受控生成测试必须明确确认计费");
  const startedAt = Date.now();
  let status = "success", errorCode: string | null = null;
  try { await executor(); } catch (cause) { status = "failure"; errorCode = String((cause as { code?: unknown })?.code ?? "RUNTIME_TEST_FAILED").slice(0, 80); }
  const durationMs = Date.now() - startedAt;
  const [id] = await connection("o_providerTestRun").insert({ providerId: input.providerId, modelId: input.modelId ?? null, testType: input.testType, status, durationMs, errorCode, createdAt: Date.now() });
  await audit(actor, `admin.provider_runtime.test.${input.testType}`, "provider_test", String(id), { providerId: input.providerId, modelId: input.modelId ?? null, status, durationMs, errorCode }, connection);
  if (status === "failure") throw new ProviderRuntimeAdminError(502, errorCode!, "Provider Runtime 测试失败");
  return { id, status, durationMs };
}

export async function listRuntimeTestHistory(actor: AuthUser, providerId: string, connection: Knex = db) {
  requireAdmin(actor);
  return connection("o_providerTestRun").where({ providerId }).select("id", "providerId", "modelId", "testType", "status", "durationMs", "errorCode", "createdAt").orderBy("createdAt", "desc").limit(100);
}
