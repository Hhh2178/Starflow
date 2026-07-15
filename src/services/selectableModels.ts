export type SelectableModelType = "text" | "image" | "video" | "all";

export interface SelectableProvider {
  id: string;
  name: string;
  enabled: boolean;
}

export interface SelectableRuntimeModel {
  providerId: string;
  modelId: string;
  displayName: string;
  capability: string;
  enabled: boolean;
}

export interface SelectableModel {
  id: string;
  label: string;
  value: string;
  type: string;
  name: string;
}

export function buildSelectableModelList(
  type: SelectableModelType,
  providers: SelectableProvider[],
  models: SelectableRuntimeModel[],
): SelectableModel[] {
  const providerById = new Map(
    providers
      .filter((provider) => provider.enabled)
      .map((provider) => [provider.id, provider] as const),
  );

  return models.flatMap((model) => {
    const provider = providerById.get(model.providerId);
    const capabilityMatches = type === "all" ? model.capability !== "video" : model.capability === type;
    if (!provider || !model.enabled || !capabilityMatches) return [];
    return [{
      id: provider.id,
      label: model.displayName,
      value: model.modelId,
      type: model.capability,
      name: provider.name,
    }];
  });
}
