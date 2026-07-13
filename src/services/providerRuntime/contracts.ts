export type ProviderCapability = "text" | "image" | "video" | "audio" | "json";

export interface ProviderExecutionRequest {
  providerId: string;
  modelId: string;
  capability: ProviderCapability;
  input: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProviderExecutionResult {
  kind: ProviderCapability;
  data: unknown;
  taskId?: string;
  usage?: unknown;
  diagnostic: { adapterId: string; providerId: string; modelId: string };
}

export type ProviderRuntimeErrorCategory =
  | "configuration" | "authentication" | "rate_limit" | "timeout" | "cancelled"
  | "invalid_request" | "upstream" | "unknown";

export class ProviderRuntimeError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: ProviderRuntimeErrorCategory,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderRuntimeError";
  }
}

export interface ProviderRuntimeAdapter {
  id: string;
  supports(request: Pick<ProviderExecutionRequest, "providerId" | "modelId" | "capability">): boolean | Promise<boolean>;
  execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult>;
}
