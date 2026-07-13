import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { db } from "@/utils/db";
import { writeAudit } from "@/services/auditLog";

export class ProviderCredentialError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ProviderCredentialError";
  }
}

export interface ProviderCredentialStatus {
  configured: boolean;
  preview: string | null;
  updatedAt: number | null;
}

export interface ProviderProbeResult {
  status: "available";
  httpStatus: number;
  latencyMs: number;
  checkedAt: number;
}

type ProtocolType = "standard" | "poll" | "webhook" | "runninghub" | "legacy";
type ProbeFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requireSuperAdmin(actor: AuthUser): void {
  if (actor.role !== "super_admin") throw new ProviderCredentialError(403, "SUPER_ADMIN_REQUIRED", "仅超级管理员可管理 Provider 凭据");
}

function parseValues(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function credentialValue(value: unknown): string {
  return String(value ?? "").replace(/^Bearer\s+/i, "").trim();
}

export function credentialStatusFromInputValues(value: unknown): ProviderCredentialStatus {
  const values = parseValues(value);
  const credential = credentialValue(values.apiKey);
  return {
    configured: credential.length > 0,
    preview: credential ? `****${credential.slice(-4)}` : null,
    updatedAt: credential && Number.isSafeInteger(values.credentialUpdatedAt) ? Number(values.credentialUpdatedAt) : null,
  };
}

async function requireVendor(providerId: string, connection: Knex) {
  const row = await connection("o_vendorConfig").where({ id: providerId }).first();
  if (!row) throw new ProviderCredentialError(404, "PROVIDER_NOT_FOUND", "Provider 不存在");
  return row;
}

export async function replaceProviderCredential(actor: AuthUser, providerId: string, credentialRaw: string, connection: Knex = db): Promise<ProviderCredentialStatus> {
  requireSuperAdmin(actor);
  const credential = credentialValue(credentialRaw);
  if (credential.length < 8 || credential.length > 8192) throw new ProviderCredentialError(422, "PROVIDER_CREDENTIAL_INVALID", "Provider 凭据长度无效");
  return connection.transaction(async (trx) => {
    const row = await requireVendor(providerId, trx);
    const updatedAt = Date.now();
    const values = { ...parseValues(row.inputValues), apiKey: credential, credentialUpdatedAt: updatedAt };
    await trx("o_vendorConfig").where({ id: providerId }).update({ inputValues: JSON.stringify(values) });
    await writeAudit({ actor, groupId: null, action: "admin.provider_runtime.credential.replace", targetType: "provider", targetId: providerId, summary: { configured: true }, result: "success" }, trx);
    return { configured: true, preview: `****${credential.slice(-4)}`, updatedAt };
  });
}

export async function clearProviderCredential(actor: AuthUser, providerId: string, connection: Knex = db): Promise<ProviderCredentialStatus> {
  requireSuperAdmin(actor);
  return connection.transaction(async (trx) => {
    const row = await requireVendor(providerId, trx);
    const values = parseValues(row.inputValues);
    delete values.apiKey;
    delete values.credentialUpdatedAt;
    await trx("o_vendorConfig").where({ id: providerId }).update({ inputValues: JSON.stringify(values) });
    await writeAudit({ actor, groupId: null, action: "admin.provider_runtime.credential.clear", targetType: "provider", targetId: providerId, summary: { configured: false }, result: "success" }, trx);
    return { configured: false, preview: null, updatedAt: null };
  });
}

export async function getProviderCredentialStatus(actor: AuthUser, providerId: string, connection: Knex = db): Promise<ProviderCredentialStatus> {
  requireSuperAdmin(actor);
  const row = await requireVendor(providerId, connection);
  return credentialStatusFromInputValues(row.inputValues);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ProviderCredentialError(422, "PROVIDER_BASE_URL_INVALID", "Provider API 地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ProviderCredentialError(422, "PROVIDER_BASE_URL_INVALID", "Provider API 地址必须是无凭据的 HTTP(S) 地址");
  return url.toString().replace(/\/$/, "");
}

function probeUrl(baseUrl: string, protocolType: ProtocolType): string {
  if (protocolType !== "standard" && protocolType !== "legacy") return baseUrl;
  return baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
}

async function executeProbe(input: { baseUrl: string; credential: string; protocolType: ProtocolType }, fetcher: ProbeFetcher): Promise<ProviderProbeResult> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const credential = credentialValue(input.credential);
  if (!credential) throw new ProviderCredentialError(422, "PROVIDER_NOT_CONFIGURED", "Provider 凭据尚未配置");
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetcher(probeUrl(baseUrl, input.protocolType), {
      method: "GET",
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProviderCredentialError(502, "PROVIDER_CONNECTION_FAILED", "Provider 连接失败");
  }
  if ([401, 403].includes(response.status)) throw new ProviderCredentialError(502, "PROVIDER_AUTHENTICATION_FAILED", `Provider 鉴权失败（HTTP ${response.status}）`);
  const checkedAt = Date.now();
  return { status: "available", httpStatus: response.status, latencyMs: checkedAt - startedAt, checkedAt };
}

async function auditProbe(actor: AuthUser, targetId: string, result: ProviderProbeResult, connection: Knex): Promise<void> {
  await writeAudit({ actor, groupId: null, action: "admin.provider_runtime.probe", targetType: "provider", targetId, summary: { status: result.status, httpStatus: result.httpStatus, latencyMs: result.latencyMs }, result: "success" }, connection);
}

export async function probeProviderDraft(actor: AuthUser, input: { baseUrl: string; credential: string; protocolType: ProtocolType }, connection: Knex = db, fetcher: ProbeFetcher = fetch): Promise<ProviderProbeResult> {
  requireSuperAdmin(actor);
  const result = await executeProbe(input, fetcher);
  await auditProbe(actor, "draft", result, connection);
  return result;
}

export async function probeProviderConnection(actor: AuthUser, providerId: string, connection: Knex = db, fetcher: ProbeFetcher = fetch): Promise<ProviderProbeResult> {
  requireSuperAdmin(actor);
  const vendor = await requireVendor(providerId, connection);
  const protocol = await connection("o_providerProtocolProfile").where({ providerId }).first();
  const values = parseValues(vendor.inputValues);
  const config = parseValues(protocol?.configJson);
  const result = await executeProbe({
    baseUrl: String(config.baseUrl ?? values.baseUrl ?? ""),
    credential: String(values.apiKey ?? ""),
    protocolType: (protocol?.protocolType ?? "legacy") as ProtocolType,
  }, fetcher);
  await auditProbe(actor, providerId, result, connection);
  return result;
}
