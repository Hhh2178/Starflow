export type GenerationTaskType = "text" | "image" | "video";

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
