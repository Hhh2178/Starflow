export type SelectableModelType = "text" | "image" | "video" | "all";

export interface SelectableProvider {
  id: string;
}

export interface SelectableLegacyModel {
  name: string;
  modelName: string;
  type: string;
}

export interface SelectableModel {
  id: string;
  label: string;
  value: string;
  type: string;
  name: string;
}

export async function buildSelectableModelList(
  type: SelectableModelType,
  providers: SelectableProvider[],
  loadModels: (providerId: string) => Promise<SelectableLegacyModel[]>,
  loadProvider: (providerId: string) => Promise<{ name: string }>,
): Promise<SelectableModel[]> {
  if (providers.length === 0) return [];

  const modelLists = await Promise.all(providers.map((provider) => loadModels(provider.id)));
  const result = await Promise.all(
    providers.map(async (provider, index) => {
      const providerData = await loadProvider(provider.id);
      const models = modelLists[index];
      const filtered = type === "all" ? models.filter((item) => item.type !== "video") : models.filter((item) => item.type === type);
      return filtered.map((item) => ({
        id: provider.id,
        label: item.name,
        value: item.modelName,
        type: item.type,
        name: providerData.name,
      }));
    }),
  );

  return result.flat();
}
