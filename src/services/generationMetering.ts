import type { BillingUnits } from "@/types/generationQueue";

function tokenCount(value: unknown): number | null {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

export function normalizeTextUsage(response: unknown): BillingUnits {
  if (!response || typeof response !== "object") return { requests: 1 };
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return { requests: 1 };
  const values = usage as Record<string, unknown>;
  const inputTokens = tokenCount(values.inputTokens ?? values.promptTokens);
  const outputTokens = tokenCount(values.outputTokens ?? values.completionTokens);
  if (inputTokens === null || outputTokens === null) return { requests: 1 };
  return { requests: 1, inputTokens, outputTokens };
}
