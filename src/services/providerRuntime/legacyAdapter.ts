import { hasLegacyVendorRuntime, loadLegacyVendorRuntime } from "@/utils/vendor";
import {
  ProviderRuntimeError,
  type ProviderExecutionRequest,
  type ProviderExecutionResult,
  type ProviderRuntimeAdapter,
} from "./contracts";

export interface LegacyRuntimeLoader {
  hasProvider(providerId: string): Promise<boolean>;
  load(providerId: string, modelId: string): Promise<{ model: any; runtime: any }>;
}

const defaultLoader: LegacyRuntimeLoader = {
  hasProvider: hasLegacyVendorRuntime,
  load: loadLegacyVendorRuntime,
};

function safeUpstreamError(cause: unknown): ProviderRuntimeError {
  if (cause instanceof ProviderRuntimeError) return cause;
  const raw = cause instanceof Error ? cause.message : String(cause);
  const category = /\b(401|403|unauthori[sz]ed|forbidden)\b/i.test(raw) ? "authentication" :
    /\b429\b|rate.?limit/i.test(raw) ? "rate_limit" : "upstream";
  const code = category === "authentication" ? "LEGACY_AUTHENTICATION_FAILED" :
    category === "rate_limit" ? "LEGACY_RATE_LIMITED" : "LEGACY_UPSTREAM_FAILED";
  const redacted = raw
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .slice(0, 300);
  return new ProviderRuntimeError(code, category, `Legacy provider request failed: ${redacted}`, cause);
}

function raceExecution<T>(operation: Promise<T>, request: ProviderExecutionRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new ProviderRuntimeError("PROVIDER_CANCELLED", "cancelled", "Provider request cancelled")));
    const timer = setTimeout(
      () => finish(() => reject(new ProviderRuntimeError("PROVIDER_TIMEOUT", "timeout", "Provider request timed out"))),
      Math.max(0, request.timeoutMs),
    );
    if (request.signal?.aborted) return onAbort();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => finish(() => resolve(value)), (cause) => finish(() => reject(safeUpstreamError(cause))));
  });
}

function mediaData(value: unknown): { sourceType: "url" | "base64"; value: string } {
  const output = String(value);
  return { sourceType: /^https?:\/\//i.test(output) ? "url" : "base64", value: output };
}

export class LegacyVendorAdapter implements ProviderRuntimeAdapter {
  readonly id = "legacy";
  constructor(private readonly loader: LegacyRuntimeLoader = defaultLoader) {}

  supports(request: Pick<ProviderExecutionRequest, "providerId" | "modelId" | "capability">): Promise<boolean> {
    return this.loader.hasProvider(request.providerId);
  }

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    const operation = this.executeLegacy(request);
    return raceExecution(operation, request);
  }

  private async executeLegacy(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    const { model, runtime } = await this.loader.load(request.providerId, request.modelId);
    const input = (request.input ?? {}) as Record<string, unknown>;
    let raw: any;
    if (request.capability === "text") {
      if (typeof runtime.textRequest !== "function") throw new ProviderRuntimeError("LEGACY_CAPABILITY_UNSUPPORTED", "configuration", "Legacy text capability unavailable");
      raw = await runtime.textRequest(model, Boolean(input.think ?? model.think), Number(input.thinkLevel ?? 0));
    } else {
      const fnName = request.capability === "image" ? "imageRequest" : request.capability === "video" ? "videoRequest" : request.capability === "audio" ? "ttsRequest" : undefined;
      if (!fnName || typeof runtime[fnName] !== "function") throw new ProviderRuntimeError("LEGACY_CAPABILITY_UNSUPPORTED", "configuration", `Legacy ${request.capability} capability unavailable`);
      raw = await runtime[fnName](request.input, model);
    }
    const diagnostic = { adapterId: this.id, providerId: request.providerId, modelId: request.modelId };
    if (request.capability === "text") return { kind: "text", data: raw, usage: raw?.usage, diagnostic };
    if (request.capability === "json") return { kind: "json", data: raw, diagnostic };
    return { kind: request.capability, data: mediaData(raw), diagnostic };
  }
}
