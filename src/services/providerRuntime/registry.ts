import type { ProviderExecutionRequest, ProviderRuntimeAdapter } from "./contracts";

export class ProviderRuntimeRegistry {
  private readonly adapters: ProviderRuntimeAdapter[] = [];

  register(adapter: ProviderRuntimeAdapter): void {
    const index = this.adapters.findIndex((item) => item.id === adapter.id);
    if (index >= 0) this.adapters[index] = adapter;
    else this.adapters.push(adapter);
  }

  async find(request: Pick<ProviderExecutionRequest, "providerId" | "modelId" | "capability">): Promise<ProviderRuntimeAdapter | undefined> {
    for (const adapter of this.adapters) {
      if (await adapter.supports(request)) return adapter;
    }
    return undefined;
  }
}
