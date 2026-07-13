import type {
  RunningHubKeyPoolRuntime,
  RunningHubRunResult,
} from "aigc-provider-runtime-kit";

type ResourceType = "app" | "workflow";
type OutputKind = "image" | "video" | "audio";

export interface RunningHubFieldBinding { nodeId: string; fieldName: string }
export interface RunningHubDescriptor {
  providerId: string;
  modelId: string;
  resourceType: ResourceType;
  resourceId: string;
  inputMapping: Record<string, RunningHubFieldBinding>;
  uploadMapping: Record<string, RunningHubFieldBinding>;
  outputRule: { kind: OutputKind; path: string };
  pollingIntervalMs: number;
  timeoutMs: number;
  enabled: boolean;
}

export interface RunningHubKeyReference {
  id: string;
  credentialRef: string;
  maxConcurrency: number;
  enabled: boolean;
  isDefault: boolean;
}

export interface RunningHubDescriptorIssue { path: string; code: string; message: string }

export class RunningHubDescriptorError extends Error {
  constructor(public readonly issues: RunningHubDescriptorIssue[]) {
    super(`RunningHub descriptor validation failed with ${issues.length} issue(s)`);
    this.name = "RunningHubDescriptorError";
  }
}

export function validateRunningHubDescriptor(value: RunningHubDescriptor): RunningHubDescriptor {
  const issues: RunningHubDescriptorIssue[] = [];
  if (value.resourceType !== "app" && value.resourceType !== "workflow") issues.push({ path: "resourceType", code: "INVALID_RESOURCE_TYPE", message: "resourceType must be app or workflow" });
  if (!value.resourceId?.trim()) issues.push({ path: "resourceId", code: "RESOURCE_ID_REQUIRED", message: "resourceId is required" });
  if (!value.providerId?.trim()) issues.push({ path: "providerId", code: "PROVIDER_ID_REQUIRED", message: "providerId is required" });
  if (!value.modelId?.trim()) issues.push({ path: "modelId", code: "MODEL_ID_REQUIRED", message: "modelId is required" });
  for (const [group, mapping] of [["inputMapping", value.inputMapping], ["uploadMapping", value.uploadMapping]] as const) {
    for (const [field, binding] of Object.entries(mapping ?? {})) {
      if (!binding.nodeId?.trim()) issues.push({ path: `${group}.${field}.nodeId`, code: "INVALID_NODE_ID", message: "nodeId is required" });
      if (!binding.fieldName?.trim()) issues.push({ path: `${group}.${field}.fieldName`, code: "INVALID_FIELD_NAME", message: "fieldName is required" });
    }
  }
  if (!value.outputRule || !["image", "video", "audio"].includes(value.outputRule.kind) || !value.outputRule.path?.trim()) {
    issues.push({ path: "outputRule", code: "INVALID_OUTPUT_RULE", message: "output kind and path are required" });
  }
  if (!Number.isInteger(value.pollingIntervalMs) || value.pollingIntervalMs < 1000 || value.pollingIntervalMs > 60000) {
    issues.push({ path: "pollingIntervalMs", code: "POLL_INTERVAL_OUT_OF_RANGE", message: "pollingIntervalMs must be between 1000 and 60000" });
  }
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 10000 || value.timeoutMs > 3600000) {
    issues.push({ path: "timeoutMs", code: "TIMEOUT_OUT_OF_RANGE", message: "timeoutMs must be between 10000 and 3600000" });
  }
  if (issues.length) throw new RunningHubDescriptorError(issues);
  return value;
}

export function sanitizeRunningHubKeyPool(keys: RunningHubKeyReference[]) {
  validateRunningHubKeyReferences(keys);
  return {
    total: keys.length,
    enabled: keys.filter((key) => key.enabled).length,
    defaultKeyId: keys.find((key) => key.enabled && key.isDefault)?.id,
    keys: keys.map(({ id, maxConcurrency, enabled, isDefault }) => ({ id, maxConcurrency, enabled, isDefault })),
  };
}

export function validateRunningHubKeyReferences(keys: RunningHubKeyReference[]): RunningHubKeyReference[] {
  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    const raw = key as RunningHubKeyReference & { apiKey?: unknown; value?: unknown };
    if (raw.apiKey !== undefined || raw.value !== undefined) throw new Error(`RunningHub key ${index} must use credentialRef only`);
    if (!key.id?.trim() || seen.has(key.id)) throw new Error(`RunningHub key id is missing or duplicate: ${key.id}`);
    seen.add(key.id);
    if (!/^(secret|env):\/\/[A-Za-z0-9_./-]+$/.test(key.credentialRef)) throw new Error(`RunningHub credentialRef is invalid for key ${key.id}`);
    if (!Number.isInteger(key.maxConcurrency) || key.maxConcurrency < 1 || key.maxConcurrency > 100) throw new Error(`RunningHub maxConcurrency is invalid for key ${key.id}`);
  }
  return keys;
}

export function serializeRunningHubDescriptor(descriptorInput: RunningHubDescriptor) {
  const descriptor = validateRunningHubDescriptor(descriptorInput);
  return {
    providerId: descriptor.providerId,
    modelId: descriptor.modelId,
    resourceType: descriptor.resourceType,
    resourceId: descriptor.resourceId,
    inputMappingJson: JSON.stringify(descriptor.inputMapping),
    uploadMappingJson: JSON.stringify(descriptor.uploadMapping),
    outputRuleJson: JSON.stringify(descriptor.outputRule),
    pollingIntervalMs: descriptor.pollingIntervalMs,
    timeoutMs: descriptor.timeoutMs,
    enabled: descriptor.enabled ? 1 : 0,
  };
}

export function deserializeRunningHubDescriptor(row: Record<string, unknown>): RunningHubDescriptor {
  const parse = (value: unknown) => JSON.parse(typeof value === "string" ? value : "{}");
  return validateRunningHubDescriptor({
    providerId: String(row.providerId ?? ""),
    modelId: String(row.modelId ?? ""),
    resourceType: row.resourceType === "app" ? "app" : "workflow",
    resourceId: String(row.resourceId ?? ""),
    inputMapping: parse(row.inputMappingJson),
    uploadMapping: parse(row.uploadMappingJson),
    outputRule: parse(row.outputRuleJson),
    pollingIntervalMs: Number(row.pollingIntervalMs),
    timeoutMs: Number(row.timeoutMs),
    enabled: Boolean(row.enabled),
  });
}

interface HostConcurrencyLease { leaseId: string }
interface HostConcurrency {
  acquire(providerId: string, modelId: string): Promise<HostConcurrencyLease | null>;
  release(lease: HostConcurrencyLease): Promise<void>;
}

export interface CreateRunningHubExecutionServiceOptions {
  baseUrl: string;
  keys: RunningHubKeyReference[];
  resolveCredential(reference: string): Promise<string | null>;
  keyRuntime: RunningHubKeyPoolRuntime;
  hostConcurrency: HostConcurrency;
  fetcher?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

export interface RunningHubExecutionResult {
  taskId: string;
  outputs: Array<{ kind: OutputKind; url: string }>;
}

type RunningHubModule = typeof import("aigc-provider-runtime-kit");
const importRunningHub = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<RunningHubModule>;

function nodeInfoList(descriptor: RunningHubDescriptor, input: Record<string, unknown>) {
  return [...Object.entries(descriptor.inputMapping), ...Object.entries(descriptor.uploadMapping)]
    .filter(([field]) => input[field] !== undefined)
    .map(([field, binding]) => ({ nodeId: binding.nodeId, fieldName: binding.fieldName, fieldValue: input[field] }));
}

function outputs(result: RunningHubRunResult, kind: OutputKind) {
  const urls = kind === "image" ? result.imageUrls : kind === "audio" ? result.audioUrls : result.videoUrls;
  return urls.map((url) => ({ kind, url }));
}

function runningHubV2Fetcher(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (!/\/openapi\/v2\/run\/workflow\//.test(url) || typeof init?.body !== "string") return fetcher(input, init);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    return fetcher(input, {
      ...init,
      body: JSON.stringify({
        addMetadata: true,
        nodeInfoList: Array.isArray(body.nodeInfoList) ? body.nodeInfoList : [],
        instanceType: "default",
        usePersonalQueue: "false",
      }),
    });
  };
}

export async function createRunningHubExecutionService(options: CreateRunningHubExecutionServiceOptions) {
  const kit = await importRunningHub("aigc-provider-runtime-kit");
  validateRunningHubKeyReferences(options.keys);
  return {
    async execute(descriptorInput: RunningHubDescriptor, input: Record<string, unknown>, control: { signal?: AbortSignal } = {}): Promise<RunningHubExecutionResult> {
      const descriptor = validateRunningHubDescriptor(descriptorInput);
      if (!descriptor.enabled) throw new Error("RunningHub descriptor is disabled");
      const hostLease = await options.hostConcurrency.acquire(descriptor.providerId, descriptor.modelId);
      if (!hostLease) throw new Error("Stars Flow concurrency limit reached");
      let acquiredKeyId: string | undefined;
      try {
        const materialized = (await Promise.all(options.keys.map(async (key) => ({
          id: key.id,
          note: key.id,
          apiKey: await options.resolveCredential(key.credentialRef) ?? undefined,
          maxConcurrency: key.maxConcurrency,
          enabled: key.enabled,
          isDefault: key.isDefault,
        }))));
        const acquired = await kit.acquireRunningHubKey({ providerId: descriptor.providerId, keys: materialized, defaultConcurrency: 1, runtime: options.keyRuntime });
        if (!acquired.acquired || !acquired.key?.apiKey) throw new Error(`RunningHub key unavailable: ${acquired.reason ?? "credential_missing"}`);
        acquiredKeyId = acquired.key.id;
        const client = kit.createRunningHubClient({
          apiKey: acquired.key.apiKey,
          baseUrl: options.baseUrl,
          fetcher: runningHubV2Fetcher(options.fetcher ?? fetch),
          wait: options.wait,
          taskTimeoutMs: descriptor.timeoutMs,
        });
        const result = await client.runTask({
          targetType: descriptor.resourceType,
          runTargetId: descriptor.resourceId,
          ...(descriptor.resourceType === "app" ? { appId: descriptor.resourceId } : { workflowId: descriptor.resourceId }),
          nodeInfoList: nodeInfoList(descriptor, input),
          pollIntervalMs: descriptor.pollingIntervalMs,
          timeoutMs: descriptor.timeoutMs,
          signal: control.signal,
        });
        return { taskId: result.upstreamTaskId, outputs: outputs(result, descriptor.outputRule.kind) };
      } finally {
        if (acquiredKeyId) await kit.releaseRunningHubKey({ providerId: descriptor.providerId, keyId: acquiredKeyId, runtime: options.keyRuntime });
        await options.hostConcurrency.release(hostLease);
      }
    },
  };
}
