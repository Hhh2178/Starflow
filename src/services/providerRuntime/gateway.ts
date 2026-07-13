import { ProviderRuntimeError, type ProviderExecutionRequest, type ProviderExecutionResult } from "./contracts";
import { ProviderRuntimeRegistry } from "./registry";

export class ProviderRuntimeGateway {
  constructor(private readonly registry: ProviderRuntimeRegistry) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionResult> {
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
}
