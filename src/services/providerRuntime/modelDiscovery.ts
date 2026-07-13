import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { db } from "@/utils/db";
import { createRuntimeModel, ProviderRuntimeAdminError } from "./adminService";

type ModelCapability = "text" | "image" | "video" | "audio" | "json";
type DiscoveryFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  suggestedCapability: ModelCapability;
}

export interface ImportModelCandidate {
  modelId: string;
  displayName: string;
  capability: ModelCapability;
}

function requireSuperAdmin(actor: AuthUser): void {
  if (actor.role !== "super_admin") throw new ProviderRuntimeAdminError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可导入 Provider 模型");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try { return objectValue(JSON.parse(value)); } catch { return {}; }
}

function modelCapability(modelId: string): ModelCapability {
  const value = modelId.toLowerCase();
  if (/(video|veo|sora|kling|seedance|hailuo|grok.*(?:video|1\.5)|wan[-_.]?\d)/.test(value)) return "video";
  if (/(image|imagen|gpt[-_.]?image|flux|dall|banana|midjourney|sdxl)/.test(value)) return "image";
  if (/(audio|speech|tts|voice|music|sound)/.test(value)) return "audio";
  return "text";
}

function cleanModelId(value: unknown): string | null {
  const id = String(value ?? "").replace(/^models\//, "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) ? id : null;
}

export function parseDiscoveredModels(payload: unknown, protocolType: string): DiscoveredModel[] {
  const source = objectValue(payload);
  let rows: unknown[] | null = null;
  if (Array.isArray(source.data)) rows = source.data;
  else if (Array.isArray(source.models)) rows = source.models;
  if (!rows || ["runninghub", "runninghub_app", "runninghub_workflow"].includes(protocolType)) {
    throw new ProviderRuntimeAdminError(422, "MODEL_CATALOG_UNSUPPORTED", "当前协议不支持模型目录拉取");
  }
  const byId = new Map<string, DiscoveredModel>();
  for (const item of rows) {
    const row = objectValue(item);
    const modelId = cleanModelId(row.id ?? row.name);
    if (!modelId) continue;
    byId.set(modelId, { modelId, displayName: String(row.displayName ?? row.display_name ?? modelId).trim() || modelId, suggestedCapability: modelCapability(modelId) });
  }
  return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

function normalizeBaseUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value ?? "").trim()); } catch { throw new ProviderRuntimeAdminError(422, "PROVIDER_BASE_URL_INVALID", "Provider API 地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ProviderRuntimeAdminError(422, "PROVIDER_BASE_URL_INVALID", "Provider API 地址必须是无凭据的 HTTP(S) 地址");
  return url.toString().replace(/\/$/, "");
}

function modelListUrl(baseUrl: string): string {
  return /\/(?:v1|v1beta)$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
}

export async function fetchProviderModels(actor: AuthUser, providerId: string, connection: Knex = db, fetcher: DiscoveryFetcher = fetch) {
  requireSuperAdmin(actor);
  const [provider, protocol, vendor] = await Promise.all([
    connection("o_providerRuntimeProfile").where({ providerId }).first(),
    connection("o_providerProtocolProfile").where({ providerId }).first(),
    connection("o_vendorConfig").where({ id: providerId }).first(),
  ]);
  if (!provider || !vendor) throw new ProviderRuntimeAdminError(404, "PROVIDER_NOT_FOUND", "Provider 不存在");
  if (!protocol) throw new ProviderRuntimeAdminError(422, "PROVIDER_PROTOCOL_MISSING", "Provider 协议尚未配置");
  const config = parseJson(protocol.configJson);
  const values = parseJson(vendor.inputValues);
  const credential = String(values.apiKey ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!credential) throw new ProviderRuntimeAdminError(422, "PROVIDER_NOT_CONFIGURED", "Provider 凭据尚未配置");
  const baseUrl = normalizeBaseUrl(config.baseUrl ?? values.baseUrl);
  let response: Response;
  try {
    response = await fetcher(modelListUrl(baseUrl), { method: "GET", headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new ProviderRuntimeAdminError(502, "MODEL_CATALOG_REQUEST_FAILED", "模型目录请求失败");
  }
  if (!response.ok) throw new ProviderRuntimeAdminError(502, "MODEL_CATALOG_REQUEST_FAILED", `模型目录请求失败（HTTP ${response.status}）`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new ProviderRuntimeAdminError(502, "MODEL_CATALOG_TOO_LARGE", "模型目录响应过大");
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new ProviderRuntimeAdminError(502, "MODEL_CATALOG_INVALID", "模型目录响应格式无效"); }
  const catalogFormat = String(config.catalogFormat ?? protocol.protocolType);
  const candidates = parseDiscoveredModels(payload, catalogFormat);
  const existing = new Set((await connection("o_providerModelProfile").where({ providerId }).select("modelId")).map((row) => String(row.modelId)));
  return candidates.map((candidate) => ({ ...candidate, exists: existing.has(candidate.modelId) }));
}

export async function importProviderModels(actor: AuthUser, providerId: string, candidates: ImportModelCandidate[], connection: Knex = db): Promise<{ imported: string[]; skipped: string[] }> {
  requireSuperAdmin(actor);
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 200) throw new ProviderRuntimeAdminError(422, "MODEL_IMPORT_SELECTION_INVALID", "请选择 1 到 200 个模型");
  return connection.transaction(async (trx) => {
    if (!(await trx("o_providerRuntimeProfile").where({ providerId }).first())) throw new ProviderRuntimeAdminError(404, "PROVIDER_NOT_FOUND", "Provider 不存在");
    const existing = new Set((await trx("o_providerModelProfile").where({ providerId }).select("modelId")).map((row) => String(row.modelId)));
    const imported: string[] = [], skipped: string[] = [];
    for (const candidate of candidates) {
      if (existing.has(candidate.modelId)) { skipped.push(candidate.modelId); continue; }
      await createRuntimeModel(actor, {
        providerId,
        modelId: candidate.modelId,
        displayName: candidate.displayName,
        capability: candidate.capability,
        executionMode: "legacy",
        protocolOverride: "legacy_adapter",
        enabled: false,
      }, trx);
      existing.add(candidate.modelId);
      imported.push(candidate.modelId);
    }
    return { imported, skipped };
  });
}
