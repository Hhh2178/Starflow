import type {
  ProviderRegistryInput,
  ValidationIssue,
} from "aigc-provider-runtime-kit";
import { ProviderRuntimeError, type ProviderExecutionRequest, type ProviderExecutionResult, type ProviderRuntimeAdapter } from "./contracts";
import { AdvancedConfigError, composeRuntimeConfig, type AdvancedConfig } from "./advancedConfig";
import { ModelCapabilityError, normalizeInputCapabilities, type ModelProtocolTemplate } from "./modelCapabilities";

type MigrationState = "legacy" | "shadow" | "native";

export interface RuntimeKitProviderProfile {
  providerId: string;
  displayName: string;
  enabled: boolean;
  migrationState: MigrationState;
  adapterId: string;
  advancedConfig?: Record<string, unknown>;
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
  inputCapabilities?: Record<string, unknown>;
  advancedConfig?: Record<string, unknown>;
  protocolOverride?: ModelProtocolTemplate | null;
  enabled: boolean;
}

export interface RuntimeKitProfileInput {
  providers: RuntimeKitProviderProfile[];
  protocols: RuntimeKitProtocolProfile[];
  models: RuntimeKitModelProfile[];
}

export interface RuntimeKitCompositionResult {
  input: Record<string, unknown>;
  config: AdvancedConfig;
  protocolTemplate: ModelProtocolTemplate;
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function protocolTemplate(protocol: RuntimeKitProtocolProfile, model: RuntimeKitModelProfile): ModelProtocolTemplate {
  const configured = String(model.protocolOverride ?? protocol.config.modelProtocolTemplate ?? "");
  const supported = new Set<ModelProtocolTemplate>(["sync_inline_result", "async_task_poll_result", "async_task_poll_then_final_lookup", "webhook_callback", "runninghub_app", "runninghub_workflow", "legacy_adapter"]);
  if (supported.has(configured as ModelProtocolTemplate)) return configured as ModelProtocolTemplate;
  return ({ standard: "sync_inline_result", poll: "async_task_poll_result", webhook: "webhook_callback", runninghub: "runninghub_app", legacy: "legacy_adapter" } as Record<string, ModelProtocolTemplate>)[protocol.protocolType] ?? "sync_inline_result";
}

function protocolAdvancedConfig(template: ModelProtocolTemplate, config: Record<string, any>): AdvancedConfig {
  const request: Record<string, unknown> = {};
  if (String(config.submitPath ?? "").trim()) request.path = String(config.submitPath).trim();
  if (String(config.requestMethod ?? "").trim()) request.method = String(config.requestMethod).trim().toUpperCase();
  const result: AdvancedConfig = Object.keys(request).length > 0 ? { request } : {};
  if (["async_task_poll_result", "async_task_poll_then_final_lookup"].includes(template)) {
    result.polling = {
      ...(String(config.statusPath ?? "").trim() ? { path: String(config.statusPath).trim() } : {}),
      intervalMs: Number(config.pollIntervalMs ?? 2000),
      timeoutMs: Number(config.pollTimeoutMs ?? 120000),
    };
  }
  if (template === "async_task_poll_then_final_lookup" && String(config.resultPath ?? "").trim()) result.finalLookup = { path: String(config.resultPath).trim() };
  return result;
}

export function composeRuntimeKitInput(input: {
  request: ProviderExecutionRequest;
  provider: RuntimeKitProviderProfile;
  model: RuntimeKitModelProfile;
  protocol: RuntimeKitProtocolProfile;
}): RuntimeKitCompositionResult {
  const rawInput = plainObject(input.request.input);
  const task = rawInput.parameters === undefined ? {} : plainObject(rawInput.parameters);
  if (rawInput.parameters !== undefined && (typeof rawInput.parameters !== "object" || rawInput.parameters === null || Array.isArray(rawInput.parameters))) throw new ProviderRuntimeError("MODEL_PARAMETERS_INVALID", "invalid_request", "模型参数必须是 JSON 对象");
  const capabilities = normalizeInputCapabilities(input.model.capability, input.model.inputCapabilities ?? {});
  if (input.request.capability === "video") {
    const frameMode = rawInput.frameMode === undefined ? "" : String(rawInput.frameMode);
    if (frameMode && !capabilities.frameModes.includes(frameMode as any)) throw new ProviderRuntimeError("VIDEO_FRAME_MODE_UNSUPPORTED", "invalid_request", `不支持的视频帧模式：${frameMode}`);
    const references = Array.isArray(rawInput.imageReferences) ? rawInput.imageReferences : [];
    if (references.length > 0 && !capabilities.imageReference.enabled) throw new ProviderRuntimeError("IMAGE_REFERENCE_UNSUPPORTED", "invalid_request", "当前模型不支持参考图");
    if (capabilities.imageReference.enabled && (references.length < capabilities.imageReference.min || references.length > capabilities.imageReference.max)) throw new ProviderRuntimeError("IMAGE_REFERENCE_COUNT_INVALID", "invalid_request", "参考图数量超出模型允许范围");
  }
  const selectedTemplate = protocolTemplate(input.protocol, input.model);
  const config = composeRuntimeConfig({
    template: protocolAdvancedConfig(selectedTemplate, input.protocol.config),
    provider: input.provider.advancedConfig ?? {},
    model: input.model.advancedConfig ?? {},
    task,
    parameterSchema: input.model.parameterSchema,
  });
  const { parameters: _parameters, ...requestInput } = rawInput;
  const requestConfig = plainObject(config.request);
  const fixedBody = plainObject(requestConfig.fixedBody);
  return { input: { ...requestInput, ...fixedBody }, config, protocolTemplate: selectedTemplate };
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
        const provider = options.profiles.providers.find((item) => item.providerId === request.providerId);
        const model = options.profiles.models.find((item) => item.providerId === request.providerId && item.modelId === request.modelId);
        const protocol = options.profiles.protocols.find((item) => item.providerId === request.providerId && item.enabled);
        if (!provider || !model || !protocol) throw new ProviderRuntimeError("RUNTIME_PROFILE_INCOMPLETE", "configuration", `Runtime profile is incomplete: ${request.providerId}/${request.modelId}`);
        const composed = composeRuntimeKitInput({ request, provider, model, protocol });
        const result = await runtime.execute({
          providerId: request.providerId,
          modelId: `${request.providerId}:${request.modelId}`,
          input: composed.input,
          signal: request.signal,
          timeoutMs: request.timeoutMs,
        });
        return normalizeKitResult(result, request, "runtime-kit");
      } catch (cause) {
        if (cause instanceof ProviderRuntimeError) throw cause;
        if (cause instanceof AdvancedConfigError || cause instanceof ModelCapabilityError) {
          throw new ProviderRuntimeError("INPUT_INVALID", "invalid_request", cause.message, cause);
        }
        const code = String((cause as { code?: unknown })?.code ?? "RUNTIME_KIT_FAILED");
        const category = code === "EXECUTION_ABORTED" ? (request.signal?.aborted ? "cancelled" : "timeout") : code === "INPUT_INVALID" ? "invalid_request" : "upstream";
        throw new ProviderRuntimeError(code, category, `Runtime Kit execution failed: ${code}`, cause);
      }
    },
  };
}
