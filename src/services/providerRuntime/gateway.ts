import { ProviderRuntimeError, type ProviderExecutionRequest, type ProviderExecutionResult } from "./contracts";
import { ProviderRuntimeRegistry } from "./registry";

export interface ProviderRouteResolution {
  migrationState: "legacy" | "shadow" | "native";
  nativeAdapterId: string;
}

export interface ProviderRoutingOptions {
  resolve(request: ProviderExecutionRequest): Promise<ProviderRouteResolution>;
  prepareNativeRequest?(request: ProviderExecutionRequest, route: ProviderRouteResolution): Promise<ProviderExecutionRequest>;
  onShadowDiagnostic?(diagnostic: { ok: boolean; adapterId: string; resultKind?: string; taskId?: string; errorCode?: string }): void | Promise<void>;
}

export class ProviderRuntimeGateway {
  constructor(private readonly registry: ProviderRuntimeRegistry, private readonly routing?: ProviderRoutingOptions) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
    if (this.routing) {
      const route = await this.routing.resolve(request);
      const legacy = this.requireAdapter("legacy", request);
      if (route.migrationState === "legacy") return legacy.execute(request);
      if (route.migrationState === "shadow") return legacy.execute(request);
      const nativeRequest = this.routing.prepareNativeRequest ? await this.routing.prepareNativeRequest(request, route) : request;
      return this.requireAdapter(route.nativeAdapterId, nativeRequest).execute(nativeRequest);
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
