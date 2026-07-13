import type {
  ProviderRegistryInput,
  ValidationIssue,
} from "aigc-provider-runtime-kit";
import { ProviderRuntimeError, type ProviderExecutionRequest, type ProviderExecutionResult, type ProviderRuntimeAdapter } from "./contracts";

type MigrationState = "legacy" | "shadow" | "native";

export interface RuntimeKitProviderProfile {
  providerId: string;
  displayName: string;
  enabled: boolean;
  migrationState: MigrationState;
  adapterId: string;
}

export interface RuntimeKitProtocolProfile {
  providerId: string;
  protocolType: string;
  config: Record<string, any>;
  enabled: boolean;
}

export interface RuntimeKitModelProfile {
  providerId: string;
  modelId: string;
  displayName: string;
  capability: "text" | "image" | "video" | "audio";
  parameterSchema: Record<string, unknown>;
  enabled: boolean;
}

export interface RuntimeKitProfileInput {
  providers: RuntimeKitProviderProfile[];
  protocols: RuntimeKitProtocolProfile[];
  models: RuntimeKitModelProfile[];
}

export class RuntimeKitRegistryError extends Error {
  constructor(public readonly issues: Array<ValidationIssue | { path: string; code: string; message: string }>) {
    super(`Runtime Kit profile mapping failed with ${issues.length} issue(s)`);
    this.name = "RuntimeKitRegistryError";
  }
}

function schemaIssues(schema: Record<string, unknown>, path: string) {
  const issues: Array<{ path: string; code: string; message: string }> = [];
  for (const [key, definition] of Object.entries(schema)) {
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
      issues.push({ path: `${path}.${key}`, code: "invalid_schema", message: "parameter definition must be an object" });
    }
  }
  return issues;
}

type RuntimeKitModule = typeof import("aigc-provider-runtime-kit");
const importRuntimeKit = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<RuntimeKitModule>;

export async function buildRuntimeKitRegistry(input: RuntimeKitProfileInput) {
  const issues: Array<ValidationIssue | { path: string; code: string; message: string }> = [];
  input.providers.forEach((provider, index) => {
    if (!provider.adapterId.trim()) issues.push({ path: `providers.${index}.adapterId`, code: "required", message: "adapterId is required" });
  });
  input.models.forEach((model, index) => issues.push(...schemaIssues(model.parameterSchema, `models.${index}.parameterSchema`)));
  if (issues.length) throw new RuntimeKitRegistryError(issues);

  const protocolByProvider = new Map(input.protocols.filter((item) => item.enabled).map((item) => [item.providerId, item]));
  const registryInput: ProviderRegistryInput = {
    providers: input.providers.map((provider) => {
      const protocol = protocolByProvider.get(provider.providerId);
      return {
        id: provider.providerId,
        name: provider.displayName,
        baseUrl: String(protocol?.config.baseUrl ?? ""),
        protocol: String(protocol?.protocolType === "standard" ? "openai" : protocol?.protocolType ?? "custom") as any,
        enabled: provider.enabled,
        note: `migration:${provider.migrationState};adapter:${provider.adapterId}`,
      };
    }),
    models: input.models.map((model) => ({
      id: `${model.providerId}:${model.modelId}`,
      providerId: model.providerId,
      modelId: model.modelId,
      displayName: model.displayName,
      capability: model.capability === "text" ? "chat" : model.capability,
      enabled: model.enabled,
      parameterSchema: model.parameterSchema,
    })),
  };
  try {
    const { createProviderRegistry } = await importRuntimeKit("aigc-provider-runtime-kit");
    return createProviderRegistry(registryInput);
  } catch (cause) {
    if (cause && typeof cause === "object" && Array.isArray((cause as { issues?: unknown }).issues)) {
      throw new RuntimeKitRegistryError((cause as { issues: ValidationIssue[] }).issues);
    }
    throw cause;
  }
}

export interface RuntimeKitClient {
  request(path: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  createChatCompletion(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  createImage(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface StarsRuntimeKitAdapterOptions {
  profiles: RuntimeKitProfileInput;
  clients: Record<string, RuntimeKitClient>;
  onDiagnostic?(event: Record<string, unknown>): void | Promise<void>;
}

function safeEvent(event: any): Record<string, unknown> {
  const safe: Record<string, unknown> = { type: String(event?.type ?? "unknown"), executionId: String(event?.executionId ?? "") };
  if (event?.adapterId) safe.adapterId = String(event.adapterId);
  if (Number.isFinite(event?.durationMs)) safe.durationMs = Number(event.durationMs);
  if (event?.progress && typeof event.progress === "object") {
    safe.progress = {
      status: String(event.progress.status ?? ""),
      percent: Number.isFinite(event.progress.percent) ? Number(event.progress.percent) : undefined,
      message: String(event.progress.message ?? "").replace(/\b(Bearer\s+\S+|sk-[A-Za-z0-9_-]+)\b/gi, "[REDACTED]").slice(0, 300),
    };
  }
  if (event?.error) safe.errorCode = String(event.error.code ?? "RUNTIME_KIT_FAILED");
  return safe;
}

function normalizeKitResult(raw: any, request: ProviderExecutionRequest, adapterId: string): ProviderExecutionResult {
  const output = raw.outputs?.[0];
  const diagnostic = { adapterId, providerId: request.providerId, modelId: request.modelId };
  if (request.capability === "text") {
    const message = raw.raw?.choices?.[0]?.message;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.flatMap((call: any) => {
      const id = String(call?.id ?? "").trim();
      const name = String(call?.function?.name ?? "").trim();
      if (!id || !name) return [];
      try {
        const args = JSON.parse(String(call?.function?.arguments ?? "{}"));
        if (!args || typeof args !== "object" || Array.isArray(args)) return [];
        return [{ id, name, arguments: args }];
      } catch {
        return [];
      }
    }) : [];
    return { kind: "text", data: { text: String(output?.text ?? ""), ...(toolCalls.length > 0 ? { toolCalls } : {}) }, usage: raw.usage, taskId: raw.taskId, diagnostic };
  }
  if (request.capability === "json") return { kind: "json", data: output?.data ?? raw.raw, taskId: raw.taskId, usage: raw.usage, diagnostic };
  const value = String(output?.url ?? output?.text ?? "");
  return { kind: request.capability, data: { sourceType: /^https?:\/\//i.test(value) ? "url" : "base64", value }, taskId: raw.taskId, usage: raw.usage, diagnostic };
}

export async function createStarsRuntimeKitAdapter(options: StarsRuntimeKitAdapterOptions): Promise<ProviderRuntimeAdapter> {
  const kit = await importRuntimeKit("aigc-provider-runtime-kit");
  const registry = await buildRuntimeKitRegistry(options.profiles);
  const adapters = Object.entries(options.clients).map(([providerId, client]) => kit.createOpenAICompatibleAdapter({ client, providerIds: [providerId], id: `openai:${providerId}` }));
  const runtime = kit.createProviderRuntime({
    registry,
    adapters,
    hooks: { onEvent: async (event) => options.onDiagnostic?.(safeEvent(event)) },
  });
  const enabledModels = new Set(options.profiles.models.filter((model) => model.enabled).map((model) => `${model.providerId}:${model.modelId}`));
  return {
    id: "runtime-kit",
    supports: ({ providerId, modelId }) => enabledModels.has(`${providerId}:${modelId}`),
    async execute(request) {
      try {
        const result = await runtime.execute({
          providerId: request.providerId,
          modelId: `${request.providerId}:${request.modelId}`,
          input: (request.input ?? {}) as Record<string, unknown>,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
        });
        return normalizeKitResult(result, request, "runtime-kit");
      } catch (cause) {
        const code = String((cause as { code?: unknown })?.code ?? "RUNTIME_KIT_FAILED");
        const category = code === "EXECUTION_ABORTED" ? (request.signal?.aborted ? "cancelled" : "timeout") : code === "INPUT_INVALID" ? "invalid_request" : "upstream";
        throw new ProviderRuntimeError(code, category, `Runtime Kit execution failed: ${code}`, cause);
      }
    },
  };
}
