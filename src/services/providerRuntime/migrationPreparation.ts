import type { Knex } from "knex";

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function prepareMimoRuntimeProfiles(connection: Knex, modelId: string) {
  if (!/^mimo-v2\.5(?:-pro)?$/.test(modelId)) throw new Error("MiMo validation model is not allowlisted");
  const vendor = await connection("o_vendorConfig").where({ id: "mimo" }).first();
  const values = parseObject(vendor?.inputValues);
  const apiKey = String(values.apiKey ?? "").replace(/^Bearer\s+/i, "").trim();
  const baseUrl = String(values.baseUrl ?? "").replace(/\/+$/, "").trim();
  if (!apiKey || !/^https?:\/\//i.test(baseUrl)) throw new Error("MiMo protected credentials or HTTP(S) base URL are not configured");
  const timestamp = Date.now();
  let modelCreated = false;
  let protocolCreated = false;
  await connection.transaction(async (trx) => {
    if (!(await trx("o_providerModelProfile").where({ providerId: "mimo", modelId }).first())) {
      await trx("o_providerModelProfile").insert({
        providerId: "mimo", modelId, displayName: modelId === "mimo-v2.5-pro" ? "MiMo V2.5 Pro" : "MiMo V2.5",
        capability: "text", executionMode: "sync", inputProfileJson: "{}", parameterSchemaJson: "{}", outputMappingJson: "{}",
        enabled: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp,
      });
      modelCreated = true;
    }
    if (!(await trx("o_providerProtocolProfile").where({ providerId: "mimo" }).first())) {
      await trx("o_providerProtocolProfile").insert({
        providerId: "mimo", protocolType: "standard",
        configJson: JSON.stringify({ baseUrl, credentialRef: "vendor://mimo/apiKey" }),
        enabled: 1, revision: 1, createdAt: timestamp, updatedAt: timestamp,
      });
      protocolCreated = true;
    }
  });
  return { modelCreated, protocolCreated, modelId };
}
