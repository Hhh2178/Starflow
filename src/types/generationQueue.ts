export type GenerationTaskType = "text" | "image" | "video";

export type BillingMode = "per_request" | "per_second" | "per_token";

export interface PricingSnapshot {
  pricingId: number;
  providerId: string;
  modelId: string;
  taskType: GenerationTaskType;
  billingMode: BillingMode;
  requestPrice?: number;
  secondPrice?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  fallbackRequestPrice?: number;
  currency: "CNY";
  version: number;
  effectiveAt: number;
}

export interface BillingUnits {
  requests?: number;
  images?: number;
  seconds?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type GenerationJobStatus =
  | "queued"
  | "running"
  | "recovering"
  | "needs_attention"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ConcurrencyLimit {
  total: number;
  text: number;
  image: number;
  video: number;
}

export interface CapacityUsage {
  total: number;
  text: number;
  image: number;
  video: number;
}

export type CapacityLimitReason =
  | "GROUP_TOTAL_LIMIT"
  | "GROUP_TYPE_LIMIT"
  | "USER_TOTAL_LIMIT"
  | "USER_TYPE_LIMIT";

export type CapacityDecision = { allowed: true } | { allowed: false; reason: CapacityLimitReason };

export interface MeteringResult {
  providerId: string | null;
  modelId: string | null;
  units: BillingUnits;
  estimatedCost: number | null;
  currency: string | null;
  pricingSnapshot: Record<string, string | number>;
  providerRequestId: string | null;
}

export interface GenerationExecutionContext {
  jobId: number;
  groupId: number;
  ownerUserId: number;
  projectId: number | null;
  signal: AbortSignal;
  heartbeat(): Promise<void>;
  setProviderRequestId(id: string): Promise<void>;
}

export interface GenerationExecutionResult<TResult> {
  result: TResult;
  metering: MeteringResult;
}

export interface GenerationJobHandler<TPayload = unknown, TResult = unknown> {
  key: string;
  taskType: GenerationTaskType;
  canRetryAfterProviderSubmission: boolean;
  parsePayload(value: unknown): TPayload;
  execute(
    context: GenerationExecutionContext,
    payload: TPayload,
  ): Promise<GenerationExecutionResult<TResult>>;
  cancel?(context: GenerationExecutionContext): Promise<void>;
}

export type ReferenceList =
  | { type: "image"; base64: string }
  | { type: "audio"; base64: string }
  | { type: "video"; base64: string };
