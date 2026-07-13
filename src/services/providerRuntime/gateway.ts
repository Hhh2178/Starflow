import { ProviderRuntimeError, type ProviderExecutionRequest, type ProviderExecutionResult } from "./contracts";
import { ProviderRuntimeRegistry } from "./registry";

export interface ProviderRouteResolution {
  migrationState: "legacy" | "shadow" | "native";
  nativeAdapterId: string;
}

export interface ProviderRoutingOptions {
  resolve(request: ProviderExecutionRequest): Promise<ProviderRouteResolution>;
  onShadowDiagnostic?(diagnostic: { ok: boolean; adapterId: string; resultKind?: string; taskId?: string; errorCode?: string }): void | Promise<void>;
}

export class ProviderRuntimeGateway {
  constructor(private readonly registry: ProviderRuntimeRegistry, private readonly routing?: ProviderRoutingOptions) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    if (this.routing) {
      const route = await this.routing.resolve(request);
      const legacy = this.requireAdapter("legacy", request);
      if (route.migrationState === "legacy") return legacy.execute(request);
      const native = this.requireAdapter(route.nativeAdapterId, request);
      if (route.migrationState === "native") return native.execute(request);
      const primary = await legacy.execute(request);
      try {
        const result = await native.execute(request);
        await this.routing.onShadowDiagnostic?.({
          ok: true,
          adapterId: native.id,
          resultKind: result.kind,
          ...(result.taskId ? { taskId: result.taskId } : {}),
        });
      } catch (cause) {
        await this.routing.onShadowDiagnostic?.({
          ok: false,
          adapterId: native.id,
          errorCode: cause instanceof ProviderRuntimeError ? cause.code : "SHADOW_EXECUTION_FAILED",
        });
      }
      return primary;
    }
    const adapter = await this.registry.find(request);
    if (!adapter) {
      throw new ProviderRuntimeError(
        "PROVIDER_ADAPTER_NOT_FOUND",
        "configuration",
        `No runtime adapter supports provider ${request.providerId} model ${request.modelId}`,
      );
    }
    return adapter.execute(request);
  }

  private requireAdapter(id: string, request: ProviderExecutionRequest) {
    const adapter = this.registry.get(id);
    if (!adapter) throw new ProviderRuntimeError("PROVIDER_ADAPTER_NOT_FOUND", "configuration", `Runtime adapter is not registered: ${id} (${request.providerId}/${request.modelId})`);
    return adapter;
  }
}
