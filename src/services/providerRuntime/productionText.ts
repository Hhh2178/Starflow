import type { Knex } from "knex";
import type { ProviderExecutionRequest, ProviderExecutionResult } from "./contracts";
import { ProviderRuntimeGateway, type ProviderRouteResolution } from "./gateway";
import { ProviderRuntimeRegistry } from "./registry";
import { createStarsRuntimeKitAdapter, type RuntimeKitClient } from "./runtimeKit";

export interface ProviderTextInvocationInput {
  system?: string;
  messages: any[];
  tools?: Record<string, {
    description?: string;
    inputSchema?: { jsonSchema?: Record<string, unknown> } | Record<string, unknown>;
    execute?: (input: unknown) => unknown | Promise<unknown>;
  }>;
  abortSignal?: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ProviderTextInvocationResult {
  text: string;
  _output?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  diagnostic?: ProviderExecutionResult["diagnostic"];
}

export interface ProviderTextRuntimeDependencies {
  resolveModel(model: string): Promise<`${string}:${string}`>;
  resolveRoute(providerId: string, modelId: string): Promise<ProviderRouteResolution>;
  legacyInvoke(model: `${string}:${string}`, input: ProviderTextInvocationInput): Promise<ProviderTextInvocationResult>;
  nativeExecute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
  prepareNativeRequest?(request: ProviderExecutionRequest, route: ProviderRouteResolution): Promise<ProviderExecutionRequest>;
}

interface ExecutionEnvelope {
  legacy: ProviderTextInvocationInput;
  native: Record<string, unknown>;
}

interface NativeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function addUsage(
  current: ProviderTextInvocationResult["usage"],
  value: unknown,
): ProviderTextInvocationResult["usage"] {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const inputTokens = (current?.inputTokens ?? 0) + (finite(row.inputTokens ?? row.promptTokens ?? row.prompt_tokens) ?? 0);
  const outputTokens = (current?.outputTokens ?? 0) + (finite(row.outputTokens ?? row.completionTokens ?? row.completion_tokens) ?? 0);
  const explicitTotal = finite(row.totalTokens ?? row.total_tokens);
  const totalTokens = (current?.totalTokens ?? 0) + (explicitTotal ?? ((finite(row.inputTokens ?? row.promptTokens ?? row.prompt_tokens) ?? 0) + (finite(row.outputTokens ?? row.completionTokens ?? row.completion_tokens) ?? 0)));
  return { inputTokens, outputTokens, totalTokens };
}

function nativeToolDefinitions(tools: ProviderTextInvocationInput["tools"]) {
  return Object.entries(tools ?? {}).map(([name, definition]) => ({
    type: "function",
    function: {
      name,
      description: definition.description ?? "",
      parameters: "jsonSchema" in (definition.inputSchema ?? {})
        ? (definition.inputSchema as { jsonSchema?: Record<string, unknown> }).jsonSchema ?? {}
        : definition.inputSchema ?? {},
    },
  }));
}

function nativeMessages(input: ProviderTextInvocationInput): any[] {
  return [
    ...(input.system ? [{ role: "system", content: input.system }] : []),
    ...input.messages.map((message) => ({
      ...message,
      content: Array.isArray(message?.content) ? message.content.map((part: any) => {
        if (part?.type !== "image") return part;
        const image = String(part.image ?? "");
        const url = /^(?:data:|https?:\/\/)/i.test(image) ? image : `data:image/png;base64,${image}`;
        return { type: "image_url", image_url: { url } };
      }) : message?.content,
    })),
  ];
}

function nativeInput(input: ProviderTextInvocationInput, messages: any[]): Record<string, unknown> {
  const tools = nativeToolDefinitions(input.tools);
  return {
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    ...(finite(input.temperature) !== undefined ? { temperature: finite(input.temperature) } : {}),
    ...(finite(input.maxOutputTokens) !== undefined ? { max_tokens: finite(input.maxOutputTokens) } : {}),
  };
}

function textData(result: ProviderExecutionResult) {
  return result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
}

function toolCalls(result: ProviderExecutionResult): NativeToolCall[] {
  const calls = textData(result).toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call) => {
    if (!call || typeof call !== "object") return [];
    const row = call as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const name = String(row.name ?? "").trim();
    const args = row.arguments;
    if (!id || !name || !args || typeof args !== "object" || Array.isArray(args)) return [];
    return [{ id, name, arguments: args as Record<string, unknown> }];
  });
}

function executionRequest(providerId: string, modelId: string, envelope: ExecutionEnvelope, signal?: AbortSignal): ProviderExecutionRequest {
  return { providerId, modelId, capability: "text", input: envelope, timeoutMs: 120_000, ...(signal ? { signal } : {}) };
}

export function createProviderTextRuntime(dependencies: ProviderTextRuntimeDependencies) {
  const registry = new ProviderRuntimeRegistry();
  const legacyAdapter = {
    id: "legacy",
    supports: () => true,
    async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
      const envelope = request.input as ExecutionEnvelope;
      const response = await dependencies.legacyInvoke(`${request.providerId}:${request.modelId}`, envelope.legacy);
      return {
        kind: "text",
        data: { text: response.text, _output: response._output },
        usage: response.usage,
        diagnostic: { adapterId: "legacy", providerId: request.providerId, modelId: request.modelId },
      };
    },
  };
  const nativeAdapter = {
    id: "runtime-kit",
    supports: () => true,
    execute: (request: ProviderExecutionRequest) => {
      const envelope = request.input as ExecutionEnvelope;
      return dependencies.nativeExecute({ ...request, input: envelope.native });
    },
  };
  registry.register(legacyAdapter);
  registry.register(nativeAdapter);
  const gateway = new ProviderRuntimeGateway(registry, {
    resolve: (request) => dependencies.resolveRoute(request.providerId, request.modelId),
    prepareNativeRequest: dependencies.prepareNativeRequest,
  });

  async function invoke(model: string, input: ProviderTextInvocationInput): Promise<ProviderTextInvocationResult> {
    const resolved = await dependencies.resolveModel(model);
    const [providerId, modelId] = resolved.split(/:(.+)/) as [string, string];
    if (!providerId || !modelId) throw new Error(`Invalid Provider model identity: ${resolved}`);
    const messages = nativeMessages(input);
    const maximumSteps = Math.max(1, Math.min(100, Object.keys(input.tools ?? {}).length * 50 || 1));
    let usage: ProviderTextInvocationResult["usage"];
    for (let step = 0; step < maximumSteps; step += 1) {
      const envelope: ExecutionEnvelope = { legacy: input, native: nativeInput(input, messages) };
      const response = await gateway.execute(executionRequest(providerId, modelId, envelope, input.abortSignal));
      usage = addUsage(usage, response.usage);
      const data = textData(response);
      if (response.diagnostic.adapterId === "legacy") {
        return { text: String(data.text ?? ""), _output: typeof data._output === "string" ? data._output : undefined, usage, diagnostic: response.diagnostic };
      }
      const calls = toolCalls(response);
      if (calls.length === 0) return { text: String(data.text ?? ""), _output: String(data.text ?? ""), usage, diagnostic: response.diagnostic };
      messages.push({
        role: "assistant",
        content: String(data.text ?? "") || null,
        tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
      });
      for (const call of calls) {
        const selected = input.tools?.[call.name];
        if (!selected?.execute) throw new Error(`Native Provider requested an unavailable tool: ${call.name}`);
        const output = await selected.execute(call.arguments);
        messages.push({ role: "tool", tool_call_id: call.id, content: typeof output === "string" ? output : JSON.stringify(output) });
      }
    }
    throw new Error("Native Provider exceeded the bounded tool-call steps");
  }

  async function compare(model: string, input: ProviderTextInvocationInput) {
    if (Object.keys(input.tools ?? {}).length > 0) throw new Error("Controlled Provider comparison does not execute tools");
    const resolved = await dependencies.resolveModel(model);
    const [providerId, modelId] = resolved.split(/:(.+)/) as [string, string];
    if (!providerId || !modelId) throw new Error(`Invalid Provider model identity: ${resolved}`);
    const messages = nativeMessages(input);
    const envelope: ExecutionEnvelope = { legacy: input, native: nativeInput(input, messages) };
    const request = executionRequest(providerId, modelId, envelope, input.abortSignal);
    const legacy = await legacyAdapter.execute(request);
    const native = await nativeAdapter.execute(request);
    return { legacy, native };
  }

  return { invoke, compare };
}

export interface ConfiguredProviderTextRuntimeOptions {
  connection: Knex;
  legacyInvoke?: ProviderTextRuntimeDependencies["legacyInvoke"];
  createClient?: (options: { baseUrl: string; apiKey: string }) => RuntimeKitClient | Promise<RuntimeKitClient>;
}

function objectJson(value: unknown): Record<string, any> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function resolveConfiguredModel(connection: Knex, model: string): Promise<`${string}:${string}`> {
  if (model.includes(":")) return model as `${string}:${string}`;
  const mode = await connection("o_setting").where({ key: "agentUseMode" }).first();
  let deployment = await connection("o_agentDeploy").where({ key: model }).first();
  if (!deployment?.modelName && mode?.value === "0") {
    const [main] = model.split(/:(.+)/);
    deployment = await connection("o_agentDeploy").where({ key: main }).first();
  }
  const resolved = String(deployment?.modelName ?? "");
  if (!/^[^:]+:.+$/.test(resolved)) throw new Error(`Provider model deployment is missing: ${model}`);
  return resolved as `${string}:${string}`;
}

async function defaultLegacyInvoke(model: `${string}:${string}`, input: ProviderTextInvocationInput): Promise<ProviderTextInvocationResult> {
  const { default: Ai } = await import("@/utils/ai");
  return await Ai.Text(model).invoke(input as any) as ProviderTextInvocationResult;
}

async function defaultClient(options: { baseUrl: string; apiKey: string }): Promise<RuntimeKitClient> {
  const kit = await import("aigc-provider-runtime-kit");
  return kit.createOpenAICompatibleClient({ baseUrl: options.baseUrl, apiKey: options.apiKey, retry: false });
}

export function createConfiguredProviderTextRuntime(options: ConfiguredProviderTextRuntimeOptions) {
  const { connection } = options;
  return createProviderTextRuntime({
    resolveModel: (model) => resolveConfiguredModel(connection, model),
    resolveRoute: async (providerId) => {
      const profile = await connection("o_providerRuntimeProfile").where({ providerId }).first();
      if (!profile) throw new Error(`Provider Runtime profile is missing: ${providerId}`);
      return { migrationState: profile.migrationState, nativeAdapterId: profile.adapterId === "legacy" ? "runtime-kit" : profile.adapterId };
    },
    legacyInvoke: options.legacyInvoke ?? defaultLegacyInvoke,
    nativeExecute: async (request) => {
      const [provider, model, protocol, vendor] = await Promise.all([
        connection("o_providerRuntimeProfile").where({ providerId: request.providerId }).first(),
        connection("o_providerModelProfile").where({ providerId: request.providerId, modelId: request.modelId }).first(),
        connection("o_providerProtocolProfile").where({ providerId: request.providerId }).first(),
        connection("o_vendorConfig").where({ id: request.providerId }).first(),
      ]);
      if (!provider || !model || !protocol || !vendor) throw new Error(`Native Provider Runtime configuration is incomplete: ${request.providerId}/${request.modelId}`);
      const protocolConfig = objectJson(protocol.configJson);
      const credentials = objectJson(vendor.inputValues);
      const baseUrl = String(protocolConfig.baseUrl ?? "").trim();
      const apiKey = String(credentials.apiKey ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!baseUrl || !apiKey) throw new Error(`Native Provider Runtime credential reference is not configured: ${request.providerId}`);
      const client = await (options.createClient ?? defaultClient)({ baseUrl, apiKey });
      const adapter = await createStarsRuntimeKitAdapter({
        profiles: {
          providers: [{ providerId: String(provider.providerId), displayName: String(provider.displayName), enabled: Boolean(provider.enabled), migrationState: provider.migrationState, adapterId: String(provider.adapterId), advancedConfig: objectJson(provider.advancedConfigJson) }],
          models: [{ providerId: String(model.providerId), modelId: String(model.modelId), displayName: String(model.displayName), capability: model.capability, parameterSchema: objectJson(model.parameterSchemaJson), inputCapabilities: objectJson(model.inputCapabilitiesJson), advancedConfig: objectJson(model.advancedConfigJson), protocolOverride: model.protocolOverride ?? null, enabled: Boolean(model.enabled) }],
          protocols: [{ providerId: String(protocol.providerId), protocolType: String(protocol.protocolType), config: protocolConfig, enabled: Boolean(protocol.enabled) }],
        },
        clients: { [request.providerId]: client },
      });
      return adapter.execute(request);
    },
  });
}

export async function invokeProviderText(model: string, input: ProviderTextInvocationInput): Promise<ProviderTextInvocationResult> {
  const { db } = await import("@/utils/db");
  return createConfiguredProviderTextRuntime({ connection: db }).invoke(model, input);
}
