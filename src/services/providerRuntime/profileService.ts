import type { Knex } from "knex";
import u from "@/utils";

export class ProviderProfileError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderProfileError";
  }
}

type Capability = "text" | "image" | "video" | "audio" | "json";
type ExecutionMode = "sync" | "background_poll" | "webhook" | "runninghub" | "legacy";
type MigrationState = "legacy" | "shadow" | "native";

export interface CreateProviderModelProfileInput {
  providerId: string;
  modelId: string;
  displayName: string;
  capability: Capability;
  executionMode: ExecutionMode;
}

export interface UpdateProviderRuntimeProfileInput {
  displayName?: string;
  enabled?: boolean;
  migrationState?: MigrationState;
  adapterId?: string;
}

function connection(db?: Knex): Knex {
  return db ?? u.db;
}

export async function createProviderModelProfile(input: CreateProviderModelProfileInput, db?: Knex) {
  const knex = connection(db);
  const provider = await knex("o_providerRuntimeProfile").where({ providerId: input.providerId }).first();
  if (!provider) throw new ProviderProfileError(422, "PROVIDER_NOT_FOUND", "Provider 不存在");
  const duplicate = await knex("o_providerModelProfile").where({ providerId: input.providerId, modelId: input.modelId }).first();
  if (duplicate) throw new ProviderProfileError(409, "PROVIDER_MODEL_CONFLICT", "Provider 模型已存在");
  const timestamp = Date.now();
  const row = {
    ...input,
    inputProfileJson: "{}",
    parameterSchemaJson: "{}",
    outputMappingJson: "{}",
    enabled: 1,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const [id] = await knex("o_providerModelProfile").insert(row);
  return await knex("o_providerModelProfile").where({ id }).first();
}

export async function updateProviderRuntimeProfile(
  providerId: string,
  expectedRevision: number,
  input: UpdateProviderRuntimeProfileInput,
  db?: Knex,
) {
  const knex = connection(db);
  const current = await knex("o_providerRuntimeProfile").where({ providerId }).first();
  if (!current) throw new ProviderProfileError(404, "PROVIDER_NOT_FOUND", "Provider 不存在");
  const patch: Record<string, unknown> = { updatedAt: Date.now(), revision: expectedRevision + 1 };
  if (input.displayName !== undefined) patch.displayName = input.displayName.trim();
  if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
  if (input.migrationState !== undefined) patch.migrationState = input.migrationState;
  if (input.adapterId !== undefined) patch.adapterId = input.adapterId.trim();
  const updated = await knex("o_providerRuntimeProfile").where({ providerId, revision: expectedRevision }).update(patch);
  if (updated !== 1) {
    throw new ProviderProfileError(409, "PROVIDER_REVISION_CONFLICT", "Provider 配置已被其他操作更新，请刷新后重试");
  }
  return await knex("o_providerRuntimeProfile").where({ providerId }).first();
}
