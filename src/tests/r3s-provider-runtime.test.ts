import assert from "node:assert/strict";
import knex, { type Knex } from "knex";
import initDB from "@/lib/initDB";
import { migrateProviderRuntimeProfiles } from "@/lib/fixDB";
import {
  createProviderModelProfile,
  ProviderProfileError,
  updateProviderRuntimeProfile,
} from "@/services/providerRuntime/profileService";
import { ProviderRuntimeGateway } from "@/services/providerRuntime/gateway";
import { LegacyVendorAdapter, type LegacyRuntimeLoader } from "@/services/providerRuntime/legacyAdapter";
import { ProviderRuntimeError, type ProviderExecutionRequest } from "@/services/providerRuntime/contracts";
import { ProviderRuntimeRegistry } from "@/services/providerRuntime/registry";
import {
  buildRuntimeKitRegistry,
  composeRuntimeKitInput,
  createStarsRuntimeKitAdapter,
  RuntimeKitRegistryError,
  type RuntimeKitProfileInput,
} from "@/services/providerRuntime/runtimeKit";
import {
  capabilityTemplate,
  normalizeCapabilityTags,
  normalizeInputCapabilities,
} from "@/services/providerRuntime/modelCapabilities";
import {
  composeRuntimeConfig,
  validateAdvancedConfig,
} from "@/services/providerRuntime/advancedConfig";

const runtimeTables = [
  "o_providerRuntimeProfile",
  "o_providerModelProfile",
  "o_providerProtocolProfile",
  "o_providerTestRun",
  "o_runningHubDescriptor",
] as const;

async function columns(db: Knex, table: string): Promise<Set<string>> {
  const rows = await db.raw(`PRAGMA table_info(${table})`);
  return new Set(rows.map((row: { name: string }) => row.name));
}

async function expectProfileError(operation: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(operation, (cause: unknown) => {
    assert.equal(cause instanceof ProviderProfileError, true);
    const error = cause as ProviderProfileError;
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

async function testFreshSchema(db: Knex): Promise<void> {
  await initDB(db, false, true);
  for (const table of runtimeTables) {
    assert.equal(await db.schema.hasTable(table), true, `${table} must exist`);
  }

  const providerColumns = await columns(db, "o_providerRuntimeProfile");
  for (const column of ["providerId", "displayName", "enabled", "migrationState", "adapterId", "note", "advancedConfigJson", "revision", "createdAt", "updatedAt"]) {
    assert.equal(providerColumns.has(column), true, `provider profile missing ${column}`);
  }
  for (const forbidden of ["apiKey", "credentials", "inputValues", "secret"]) {
    assert.equal(providerColumns.has(forbidden), false, `provider profile must not contain ${forbidden}`);
  }

  const modelColumns = await columns(db, "o_providerModelProfile");
  for (const column of ["providerId", "modelId", "displayName", "capability", "executionMode", "parameterSchemaJson", "capabilityTagsJson", "inputCapabilitiesJson", "advancedConfigJson", "protocolOverride", "enabled", "revision", "createdAt", "updatedAt"]) {
    assert.equal(modelColumns.has(column), true, `model profile missing ${column}`);
  }
  const protocolColumns = await columns(db, "o_providerProtocolProfile");
  for (const column of ["providerId", "protocolType", "configJson", "enabled", "revision", "createdAt", "updatedAt"]) {
    assert.equal(protocolColumns.has(column), true, `protocol profile missing ${column}`);
  }
  const descriptorColumns = await columns(db, "o_runningHubDescriptor");
  for (const column of ["providerId", "modelId", "resourceType", "resourceId", "inputMappingJson", "uploadMappingJson", "outputRuleJson", "enabled", "revision", "createdAt", "updatedAt"]) {
    assert.equal(descriptorColumns.has(column), true, `RunningHub descriptor missing ${column}`);
  }

  const vendors = await db("o_vendorConfig").select("id", "enable", "models").orderBy("id");
  const profiles = await db("o_providerRuntimeProfile").select("*").orderBy("providerId");
  const validVendors = vendors.filter((vendor) => typeof vendor.id === "string"
    && vendor.id.trim().length > 0
    && !["null", "undefined"].includes(vendor.id.trim().toLowerCase()));
  assert.equal(profiles.length, validVendors.length);
  assert.equal(profiles.some((profile) => ["", "null", "undefined"].includes(String(profile.providerId).trim().toLowerCase())), false);
  for (const vendor of validVendors) {
    const profile = profiles.find((item) => item.providerId === vendor.id);
    assert.ok(profile, `missing legacy profile for ${vendor.id}`);
    assert.equal(profile.migrationState, "legacy");
    assert.equal(profile.enabled, vendor.enable);
    assert.equal(profile.revision, 1);
    assert.equal((await db("o_vendorConfig").where({ id: vendor.id }).first()).models, vendor.models);
  }

  await assert.rejects(db("o_providerRuntimeProfile").insert({
    providerId: vendors[0].id,
    displayName: vendors[0].id,
    enabled: 0,
    migrationState: "legacy",
    adapterId: "legacy",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }));
}

async function testRuntimeV2ColumnMigration(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    await db.schema.createTable("o_providerRuntimeProfile", (table) => {
      table.increments("id").primary();
      table.text("providerId").notNullable().unique();
      table.text("displayName").notNullable();
      table.boolean("enabled").notNullable().defaultTo(false);
      table.text("migrationState").notNullable().defaultTo("legacy");
      table.text("adapterId").notNullable().defaultTo("legacy");
      table.integer("revision").notNullable().defaultTo(1);
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
    });
    await db.schema.createTable("o_providerModelProfile", (table) => {
      table.increments("id").primary();
      table.text("providerId").notNullable();
      table.text("modelId").notNullable();
      table.text("displayName").notNullable();
      table.text("capability").notNullable();
      table.text("executionMode").notNullable();
      table.text("inputProfileJson").notNullable().defaultTo("{}");
      table.text("parameterSchemaJson").notNullable().defaultTo("{}");
      table.text("outputMappingJson").notNullable().defaultTo("{}");
      table.boolean("enabled").notNullable().defaultTo(true);
      table.integer("revision").notNullable().defaultTo(1);
      table.integer("createdAt").notNullable();
      table.integer("updatedAt").notNullable();
      table.unique(["providerId", "modelId"]);
    });
    await db("o_vendorConfig").insert({ id: "legacy-v2", inputValues: "{}", models: "[]", enable: 1 });
    await db("o_vendorConfig").insert({ id: "null", inputValues: "{}", models: "[]", enable: 1 });
    await db("o_providerRuntimeProfile").insert({ providerId: "legacy-v2", displayName: "Legacy V2", enabled: 1, migrationState: "legacy", adapterId: "legacy", revision: 1, createdAt: 1, updatedAt: 1 });
    await db("o_providerRuntimeProfile").insert({ providerId: "null", displayName: "null", enabled: 1, migrationState: "legacy", adapterId: "legacy", revision: 1, createdAt: 1, updatedAt: 1 });
    await db("o_providerModelProfile").insert({ providerId: "legacy-v2", modelId: "video-a", displayName: "Video A", capability: "video", executionMode: "legacy", enabled: 1, revision: 1, createdAt: 1, updatedAt: 1 });

    await migrateProviderRuntimeProfiles(db);
    assert.equal(await db("o_providerRuntimeProfile").where({ providerId: "null" }).first(), undefined);
    const providerColumns = await columns(db, "o_providerRuntimeProfile");
    const modelColumns = await columns(db, "o_providerModelProfile");
    assert.equal(providerColumns.has("note"), true);
    assert.equal(providerColumns.has("advancedConfigJson"), true);
    for (const column of ["capabilityTagsJson", "inputCapabilitiesJson", "advancedConfigJson", "protocolOverride"]) assert.equal(modelColumns.has(column), true);

    await db("o_providerRuntimeProfile").where({ providerId: "legacy-v2" }).update({ note: "keep-note", advancedConfigJson: JSON.stringify({ request: { method: "POST" } }) });
    await db("o_providerModelProfile").where({ providerId: "legacy-v2", modelId: "video-a" }).update({ capabilityTagsJson: JSON.stringify(["first_frame_video"]), inputCapabilitiesJson: JSON.stringify({ frameModes: ["first_frame"] }), advancedConfigJson: JSON.stringify({ request: { fixedBody: { model: "video-a" } } }), protocolOverride: "async_task_poll_result" });

    await migrateProviderRuntimeProfiles(db);
    const provider = await db("o_providerRuntimeProfile").where({ providerId: "legacy-v2" }).first();
    const model = await db("o_providerModelProfile").where({ providerId: "legacy-v2", modelId: "video-a" }).first();
    assert.equal(provider.note, "keep-note");
    assert.deepEqual(JSON.parse(provider.advancedConfigJson), { request: { method: "POST" } });
    assert.deepEqual(JSON.parse(model.capabilityTagsJson), ["first_frame_video"]);
    assert.deepEqual(JSON.parse(model.inputCapabilitiesJson), { frameModes: ["first_frame"] });
    assert.deepEqual(JSON.parse(model.advancedConfigJson), { request: { fixedBody: { model: "video-a" } } });
    assert.equal(model.protocolOverride, "async_task_poll_result");
  } finally {
    await db.destroy();
  }
}

function testModelCapabilityContracts(): void {
  assert.deepEqual(normalizeCapabilityTags(["video_generation", "first_frame_video", "first_frame_video"]), ["video_generation", "first_frame_video"]);
  assert.throws(() => normalizeCapabilityTags(["unsupported_capability"]), /能力标签/);
  assert.deepEqual(normalizeInputCapabilities("video", {
    prompt: true,
    imageReference: { enabled: true, min: 0, max: 3 },
    frameModes: ["first_frame", "first_last_frame"],
  }), {
    prompt: true,
    systemPrompt: false,
    imageReference: { enabled: true, min: 0, max: 3 },
    frameModes: ["first_frame", "first_last_frame"],
    mask: false,
    videoReference: false,
    audioReference: false,
  });
  assert.throws(() => normalizeInputCapabilities("video", { imageReference: { enabled: true, min: 4, max: 2 } }), /引用图|范围/);
  assert.throws(() => normalizeInputCapabilities("text", { frameModes: ["first_frame"] }), /视频模型/);
  const textTemplate = capabilityTemplate("text");
  assert.deepEqual(textTemplate.capabilityTags, ["text_chat"]);
  assert.deepEqual(textTemplate.parameterSchema.reasoningEffort, undefined);
  assert.equal(textTemplate.inputCapabilities.prompt, true);
}

function testAdvancedConfigContracts(): void {
  assert.throws(() => validateAdvancedConfig({ request: { headers: { Authorization: "Bearer value" } } }), /敏感|凭据/);
  assert.throws(() => validateAdvancedConfig({ request: { fixedBody: { value: "${process.env.SECRET}" } } }), /表达式|执行/);
  assert.throws(() => validateAdvancedConfig({ unsupported: {} }), /不支持/);
  assert.throws(() => validateAdvancedConfig({ polling: { intervalMs: 20, timeoutMs: 1000 } }), /轮询间隔/);
  const lowerCaseMethod = { request: { method: "post" } };
  assert.equal(validateAdvancedConfig(lowerCaseMethod).request?.method, "POST");
  assert.equal(lowerCaseMethod.request.method, "post");
  const composed = composeRuntimeConfig({
    template: { request: { fixedBody: { a: 1, shared: "template" } } },
    provider: { request: { fixedBody: { b: 2, shared: "provider" } } },
    model: { request: { fixedBody: { c: 3, shared: "model" } } },
    task: { duration: 8 },
    parameterSchema: { duration: { type: "integer", min: 4, max: 12 } },
  });
  assert.deepEqual(composed.request?.fixedBody, { a: 1, b: 2, c: 3, shared: "model", duration: 8 });
  assert.throws(() => composeRuntimeConfig({ template: {}, provider: {}, model: {}, task: { unknown: true }, parameterSchema: {} }), /未声明参数/);
  assert.throws(() => composeRuntimeConfig({ template: {}, provider: {}, model: {}, task: { duration: 20 }, parameterSchema: { duration: { type: "integer", min: 4, max: 12 } } }), /duration/);
}

async function testProfileService(db: Knex): Promise<void> {
  await expectProfileError(createProviderModelProfile({
    providerId: "missing-provider",
    modelId: "missing-model",
    displayName: "Missing Model",
    capability: "text",
    executionMode: "sync",
  }, db), 422, "PROVIDER_NOT_FOUND");

  const provider = await db("o_providerRuntimeProfile").orderBy("providerId").first();
  const created = await createProviderModelProfile({
    providerId: provider.providerId,
    modelId: "text-alpha",
    displayName: "Text Alpha",
    capability: "text",
    executionMode: "sync",
  }, db);
  assert.equal(created.revision, 1);
  await expectProfileError(createProviderModelProfile({
    providerId: provider.providerId,
    modelId: "text-alpha",
    displayName: "Duplicate",
    capability: "text",
    executionMode: "sync",
  }, db), 409, "PROVIDER_MODEL_CONFLICT");

  const updated = await updateProviderRuntimeProfile(provider.providerId, 1, { displayName: "Updated Provider" }, db);
  assert.equal(updated.revision, 2);
  assert.equal(updated.displayName, "Updated Provider");
  await expectProfileError(
    updateProviderRuntimeProfile(provider.providerId, 1, { enabled: false }, db),
    409,
    "PROVIDER_REVISION_CONFLICT",
  );
}

async function testLegacyMigration(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await db.schema.createTable("o_vendorConfig", (table) => {
      table.string("id").primary();
      table.text("inputValues");
      table.text("models");
      table.integer("enable");
    });
    await db("o_vendorConfig").insert([
      { id: "legacy-a", inputValues: JSON.stringify({ apiKey: "must-stay-here" }), models: "[]", enable: 1 },
      { id: "legacy-b", inputValues: "{}", models: JSON.stringify([{ modelName: "b" }]), enable: 0 },
    ]);

    await migrateProviderRuntimeProfiles(db);
    await migrateProviderRuntimeProfiles(db);
    const profiles = await db("o_providerRuntimeProfile").select("*").orderBy("providerId");
    assert.equal(profiles.length, 2);
    assert.deepEqual(profiles.map((item) => [item.providerId, item.enabled, item.migrationState]), [
      ["legacy-a", 1, "legacy"],
      ["legacy-b", 0, "legacy"],
    ]);
    assert.equal(JSON.parse((await db("o_vendorConfig").where({ id: "legacy-a" }).first()).inputValues).apiKey, "must-stay-here");
    assert.equal((await db("o_vendorConfig").where({ id: "legacy-b" }).first()).models, JSON.stringify([{ modelName: "b" }]));
  } finally {
    await db.destroy();
  }
}

async function expectRuntimeError(operation: Promise<unknown>, code: string, category: string): Promise<ProviderRuntimeError> {
  let captured: ProviderRuntimeError | undefined;
  await assert.rejects(operation, (cause: unknown) => {
    assert.equal(cause instanceof ProviderRuntimeError, true);
    captured = cause as ProviderRuntimeError;
    assert.equal(captured.code, code);
    assert.equal(captured.category, category);
    return true;
  });
  return captured!;
}

async function testLegacyAdapterBridge(): Promise<void> {
  const calls: Array<{ providerId: string; modelId: string; capability: string; input: unknown }> = [];
  let deferredResolve: ((value: string) => void) | undefined;
  const loader: LegacyRuntimeLoader = {
    hasProvider: async (providerId) => ["mimo", "grsai", "aicopy", "slow", "broken"].includes(providerId),
    load: async (providerId, modelId) => ({
      model: { modelName: modelId, think: false },
      runtime: {
        textRequest: async (_model: unknown, _think: boolean, _level: number) => ({ text: "桥接文本", usage: { inputTokens: 4, outputTokens: 2 } }),
        imageRequest: async (input: unknown) => {
          calls.push({ providerId, modelId, capability: "image", input });
          return "https://media.invalid/image.png";
        },
        videoRequest: async (input: unknown) => {
          calls.push({ providerId, modelId, capability: "video", input });
          if (providerId === "slow") return await new Promise<string>((resolve) => { deferredResolve = resolve; });
          if (providerId === "broken") throw new Error("401 Unauthorized Bearer sk-live-secret");
          return "data:video/mp4;base64,AAAA";
        },
      },
    }),
  };
  const adapter = new LegacyVendorAdapter(loader);
  assert.equal(await adapter.supports({ providerId: "mimo", modelId: "mimo-v2.5", capability: "text" }), true);
  assert.equal(await adapter.supports({ providerId: "missing", modelId: "none", capability: "text" }), false);

  const base = { timeoutMs: 1000 };
  const text = await adapter.execute({ ...base, providerId: "mimo", modelId: "mimo-v2.5", capability: "text", input: { think: true, thinkLevel: 2 } });
  assert.deepEqual(text, {
    kind: "text",
    data: { text: "桥接文本", usage: { inputTokens: 4, outputTokens: 2 } },
    usage: { inputTokens: 4, outputTokens: 2 },
    diagnostic: { adapterId: "legacy", providerId: "mimo", modelId: "mimo-v2.5" },
  });
  const image = await adapter.execute({ ...base, providerId: "grsai", modelId: "nano-banana", capability: "image", input: { prompt: "图像" } });
  assert.equal(image.kind, "image");
  assert.deepEqual(image.data, { sourceType: "url", value: "https://media.invalid/image.png" });
  const video = await adapter.execute({ ...base, providerId: "aicopy", modelId: "grok-video", capability: "video", input: { prompt: "视频" } });
  assert.equal(video.kind, "video");
  assert.deepEqual(video.data, { sourceType: "base64", value: "data:video/mp4;base64,AAAA" });
  assert.equal(calls.length, 2);

  const authError = await expectRuntimeError(
    adapter.execute({ ...base, providerId: "broken", modelId: "video", capability: "video", input: {} }),
    "LEGACY_AUTHENTICATION_FAILED",
    "authentication",
  );
  assert.equal(authError.message.includes("sk-live-secret"), false);

  const controller = new AbortController();
  let completionCount = 0;
  const cancelled = adapter.execute({ ...base, providerId: "slow", modelId: "video", capability: "video", input: {}, signal: controller.signal })
    .then(() => { completionCount += 1; }, (cause) => { completionCount += 1; throw cause; });
  controller.abort();
  await expectRuntimeError(cancelled, "PROVIDER_CANCELLED", "cancelled");
  deferredResolve?.("https://media.invalid/late.mp4");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(completionCount, 1);

  await expectRuntimeError(
    adapter.execute({ providerId: "slow", modelId: "video", capability: "video", input: {}, timeoutMs: 5 }),
    "PROVIDER_TIMEOUT",
    "timeout",
  );
  deferredResolve?.("https://media.invalid/late-timeout.mp4");
}

async function testRuntimeGateway(): Promise<void> {
  const requests: ProviderExecutionRequest[] = [];
  const registry = new ProviderRuntimeRegistry();
  registry.register({
    id: "fake",
    supports: async ({ providerId }) => providerId === "provider-a",
    execute: async (request) => {
      requests.push(request);
      return { kind: "json", data: { ok: true }, diagnostic: { adapterId: "fake", providerId: request.providerId, modelId: request.modelId } };
    },
  });
  const gateway = new ProviderRuntimeGateway(registry);
  const result = await gateway.execute({ providerId: "provider-a", modelId: "model-a", capability: "json", input: {}, timeoutMs: 1000 });
  assert.equal(result.kind, "json");
  assert.equal(requests.length, 1);
  await expectRuntimeError(
    gateway.execute({ providerId: "missing", modelId: "none", capability: "json", input: {}, timeoutMs: 1000 }),
    "PROVIDER_ADAPTER_NOT_FOUND",
    "configuration",
  );
}

function validRuntimeKitProfiles(): RuntimeKitProfileInput {
  return {
    providers: [{ providerId: "native-a", displayName: "Native A", enabled: true, migrationState: "native", adapterId: "openai", advancedConfig: { request: { fixedBody: { region: "cn", shared: "provider" } } } }],
    protocols: [{ providerId: "native-a", protocolType: "standard", config: { baseUrl: "https://api.invalid/v1", modelProtocolTemplate: "sync_inline_result", submitPath: "/chat/completions" }, enabled: true }],
    models: [{ providerId: "native-a", modelId: "chat-a", displayName: "Chat A", capability: "text", parameterSchema: { temperature: { type: "number", min: 0, max: 2 } }, inputCapabilities: { prompt: true }, advancedConfig: { request: { fixedBody: { model: "chat-a", shared: "model" } } }, protocolOverride: "sync_inline_result", enabled: true }],
  };
}

function testRuntimeComposition(): void {
  const profiles = validRuntimeKitProfiles();
  const composed = composeRuntimeKitInput({
    request: { providerId: "native-a", modelId: "chat-a", capability: "text", input: { messages: [{ role: "user", content: "hello" }], parameters: { temperature: 0.4 } }, timeoutMs: 1000 },
    provider: profiles.providers[0], model: profiles.models[0], protocol: profiles.protocols[0],
  });
  assert.deepEqual(composed.input, { messages: [{ role: "user", content: "hello" }], region: "cn", shared: "model", model: "chat-a", temperature: 0.4 });
  assert.equal(composed.protocolTemplate, "sync_inline_result");
  assert.equal((composed.config.request as any).path, "/chat/completions");
  assert.throws(() => composeRuntimeKitInput({
    request: { providerId: "native-a", modelId: "chat-a", capability: "text", input: { parameters: { unsupported: true } }, timeoutMs: 1000 },
    provider: profiles.providers[0], model: profiles.models[0], protocol: profiles.protocols[0],
  }), /未声明参数/);

  const videoModel = { ...profiles.models[0], capability: "video" as const, inputCapabilities: { imageReference: { enabled: true, min: 1, max: 3 }, frameModes: ["first_frame", "first_last_frame"] }, parameterSchema: {} };
  assert.equal(composeRuntimeKitInput({ request: { providerId: "native-a", modelId: "video-a", capability: "video", input: { frameMode: "first_frame", imageReferences: ["one"] }, timeoutMs: 1000 }, provider: profiles.providers[0], model: videoModel, protocol: profiles.protocols[0] }).input.frameMode, "first_frame");
  assert.throws(() => composeRuntimeKitInput({ request: { providerId: "native-a", modelId: "video-a", capability: "video", input: { frameMode: "last_frame", imageReferences: ["one"] }, timeoutMs: 1000 }, provider: profiles.providers[0], model: videoModel, protocol: profiles.protocols[0] }), /视频帧模式/);
}

async function expectRegistryError(input: RuntimeKitProfileInput, issueCode: string): Promise<void> {
  await assert.rejects(buildRuntimeKitRegistry(input), (cause: unknown) => {
    assert.equal(cause instanceof RuntimeKitRegistryError, true);
    assert.equal((cause as RuntimeKitRegistryError).issues.some((issue) => issue.code === issueCode), true);
    return true;
  });
}

async function testRuntimeKitRegistryMapping(): Promise<void> {
  const registry = await buildRuntimeKitRegistry(validRuntimeKitProfiles());
  assert.equal(registry.getProvider("native-a")?.baseUrl, "https://api.invalid/v1");
  assert.equal(registry.getModel("native-a:chat-a")?.capability, "chat");
  assert.equal(registry.listModels({ enabledOnly: true }).length, 1);

  const malformedUrl = validRuntimeKitProfiles();
  malformedUrl.protocols[0].config.baseUrl = "file:///private/secret";
  await expectRegistryError(malformedUrl, "invalid");
  const duplicate = validRuntimeKitProfiles();
  duplicate.providers.push({ ...duplicate.providers[0] });
  await expectRegistryError(duplicate, "duplicate");
  const missingAdapter = validRuntimeKitProfiles();
  missingAdapter.providers[0].adapterId = "";
  await expectRegistryError(missingAdapter, "required");
  const disabled = validRuntimeKitProfiles();
  disabled.models[0].enabled = false;
  assert.equal((await buildRuntimeKitRegistry(disabled)).listModels({ enabledOnly: true }).length, 0);
  const malformedSchema = validRuntimeKitProfiles();
  malformedSchema.models[0].parameterSchema = { prompt: "invalid" } as unknown as Record<string, unknown>;
  await expectRegistryError(malformedSchema, "invalid_schema");
}

async function testRuntimeKitOpenAIExecution(): Promise<void> {
  const profiles = validRuntimeKitProfiles();
  const diagnostics: unknown[] = [];
  const calls: unknown[] = [];
  const adapter = await createStarsRuntimeKitAdapter({
    profiles,
    clients: {
      "native-a": {
        request: async () => ({}),
        createImage: async () => ({}),
        createChatCompletion: async (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
          calls.push({ body, hasSignal: Boolean(options?.signal) });
          return { choices: [{ message: { content: "native text" } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, secret: "sk-runtime-secret" };
        },
      },
    },
    onDiagnostic: (event) => { diagnostics.push(event); },
  });
  const result = await adapter.execute({ providerId: "native-a", modelId: "chat-a", capability: "text", input: { prompt: "hello", messages: [] }, timeoutMs: 1000 });
  assert.equal(result.kind, "text");
  assert.deepEqual(result.data, { text: "native text" });
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes("sk-runtime-secret"), false);
  await expectRuntimeError(
    adapter.execute({ providerId: "native-a", modelId: "chat-a", capability: "text", input: { messages: [], parameters: { unsupported: true } }, timeoutMs: 1000 }),
    "INPUT_INVALID",
    "invalid_request",
  );

  const timeoutAdapter = await createStarsRuntimeKitAdapter({
    profiles,
    clients: {
      "native-a": {
        request: async () => await new Promise(() => undefined),
        createImage: async () => await new Promise(() => undefined),
        createChatCompletion: async () => await new Promise(() => undefined),
      },
    },
  });
  await expectRuntimeError(
    timeoutAdapter.execute({ providerId: "native-a", modelId: "chat-a", capability: "text", input: { prompt: "timeout" }, timeoutMs: 5 }),
    "EXECUTION_ABORTED",
    "timeout",
  );
}

async function testRuntimeKitOpenAIToolCallNormalization(): Promise<void> {
  const adapter = await createStarsRuntimeKitAdapter({
    profiles: validRuntimeKitProfiles(),
    clients: {
      "native-a": {
        request: async () => ({}),
        createImage: async () => ({}),
        createChatCompletion: async () => ({
          choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "record", arguments: "{\"value\":\"ok\"}" } }] } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      },
    },
  });
  const result = await adapter.execute({ providerId: "native-a", modelId: "chat-a", capability: "text", input: { prompt: "tool", messages: [] }, timeoutMs: 1000 });
  assert.deepEqual(result.data, { text: "", toolCalls: [{ id: "call-1", name: "record", arguments: { value: "ok" } }] });
}

async function testMigrationRouting(): Promise<void> {
  const calls: string[] = [];
  const registry = new ProviderRuntimeRegistry();
  const result = (adapterId: string, value: string) => ({ kind: "text" as const, data: { text: value }, diagnostic: { adapterId, providerId: "p", modelId: "m" } });
  registry.register({ id: "legacy", supports: () => true, execute: async () => { calls.push("legacy"); return result("legacy", "legacy"); } });
  registry.register({ id: "native", supports: () => true, execute: async () => { calls.push("native"); return result("native", "native"); } });
  let state: "legacy" | "shadow" | "native" = "legacy";
  const shadows: unknown[] = [];
  let prepared = 0;
  const gateway = new ProviderRuntimeGateway(registry, {
    resolve: async () => ({ migrationState: state, nativeAdapterId: "native" }),
    prepareNativeRequest: async (value) => { prepared += 1; return { ...value, input: { prepared: true } }; },
    onShadowDiagnostic: async (diagnostic) => { shadows.push(diagnostic); },
  });
  const request: ProviderExecutionRequest = { providerId: "p", modelId: "m", capability: "text", input: {}, timeoutMs: 1000 };
  assert.equal((await gateway.execute(request)).diagnostic.adapterId, "legacy");
  state = "native";
  assert.equal((await gateway.execute(request)).diagnostic.adapterId, "native");
  state = "shadow";
  assert.equal((await gateway.execute(request)).diagnostic.adapterId, "legacy");
  assert.deepEqual(calls, ["legacy", "native", "legacy"]);
  assert.equal(prepared, 1);
  assert.equal(shadows.length, 0);
}

async function main(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await testFreshSchema(db);
    await testProfileService(db);
  } finally {
    await db.destroy();
  }
  await testLegacyMigration();
  await testRuntimeV2ColumnMigration();
  testModelCapabilityContracts();
  testAdvancedConfigContracts();
  testRuntimeComposition();
  await testLegacyAdapterBridge();
  await testRuntimeGateway();
  await testRuntimeKitRegistryMapping();
  await testRuntimeKitOpenAIExecution();
  await testRuntimeKitOpenAIToolCallNormalization();
  await testMigrationRouting();
  console.log("R3S provider runtime profile tests passed");
}

main().then(
  () => process.exit(0),
  (cause) => {
    console.error(cause);
    process.exit(1);
  },
);
