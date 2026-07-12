import fs from "fs/promises";
import path from "path";
import isPathInside from "is-path-inside";
import type { Knex } from "knex";
import u from "@/utils";
import type { GenerationExecutionContext, GenerationExecutionResult } from "@/types/generationQueue";
import type { TextGenerationPayload } from "@/jobs/handlers/textGeneration";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { executeQueuedAgent } from "@/services/agentQueue";
import { normalizeTextUsage } from "@/services/generationMetering";

type ExecutorConnection = Knex | Knex.Transaction;

interface TextInvocationInput {
  system?: string;
  messages: any[];
  tools?: Record<string, any>;
  abortSignal?: AbortSignal;
}

export interface CoreTextExecutorDependencies {
  connection?: ExecutorConnection;
  getPath?: (segments: string[]) => string;
  readFile?: (filePath: string) => Promise<string>;
  getArtPrompt?: (styleName: string, source: string, fileName: string) => string;
  getImageBase64?: (path: string) => Promise<string>;
  invokeText?: (model: "universalAi", input: TextInvocationInput) => Promise<{
    text: string;
    _output?: string;
    usage?: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
  }>;
}

function unknownCostMetering(modelId: string, response?: unknown) {
  return {
    providerId: null,
    modelId,
    units: normalizeTextUsage(response),
    estimatedCost: null,
    currency: null,
    pricingSnapshot: {},
    providerRequestId: null,
  };
}

function automaticVideoPromptFile(modelName: string, mode: string): string | null {
  const modelLower = modelName.toLowerCase();
  if (modelLower.includes("wan") && modelLower.includes("2.6")) {
    return "wan2.6Single-imageFirstFrameMode.md";
  }
  if (/seedance.*2[.\-]0/i.test(modelLower)) return "seedance2Multi-parameterMode.md";
  if (["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) {
    return "universalFirstAndLastFrameMode.md";
  }
  if (mode.startsWith('["') && mode.endsWith('"]')) return "universalMulti-parameterMode.md";
  return null;
}

async function tryReadTemplate(
  readFile: (filePath: string) => Promise<string>,
  filePath: string,
): Promise<string | undefined> {
  try {
    return (await readFile(filePath)) || undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function markProviderSubmission(context: GenerationExecutionContext, operation: string) {
  await context.setProviderRequestId(`${operation}:${context.jobId}`);
}

async function executeStylePrompt(
  payload: Extract<TextGenerationPayload, { operation: "style_prompt" }>,
  context: GenerationExecutionContext,
  dependencies: Required<CoreTextExecutorDependencies>,
): Promise<GenerationExecutionResult<unknown>> {
  const project = await dependencies.connection("o_project").where({ id: payload.projectId }).select("id").first();
  if (!project) throw new Error("项目不存在");
  const images = await Promise.all(payload.images.map(async (image) => ({
    type: "image" as const,
    image: await dependencies.getImageBase64(image.slice(4).replace("/smallImage", "")),
  })));
  await markProviderSubmission(context, payload.operation);
  const response = await dependencies.invokeText("universalAi", {
    system: "请根据图片提取一个综合画风提示词。仅输出包含中英文描述且带有‘画风’二字的括号内容。",
    messages: [{ role: "user", content: images }],
    abortSignal: context.signal,
  });
  const prompt = response.text?.trim();
  if (!prompt) throw new Error("画风分析未返回结果");
  return { result: { prompt }, metering: unknownCostMetering(payload.model, response) };
}

const assetPromptConfig = {
  role: { label: "角色", manual: "art_character", derivativeManual: "art_character_derivative" },
  scene: { label: "场景", manual: "art_scene", derivativeManual: "art_scene_derivative" },
  tool: { label: "道具", manual: "art_prop", derivativeManual: "art_prop_derivative" },
} as const;

async function executeAssetPrompt(
  payload: Extract<TextGenerationPayload, { operation: "asset_prompt" }>,
  context: GenerationExecutionContext,
  dependencies: Required<CoreTextExecutorDependencies>,
): Promise<GenerationExecutionResult<unknown>> {
  const { connection } = dependencies;
  const [project, asset] = await Promise.all([
    connection("o_project").where({ id: payload.projectId }).select("artStyle").first(),
    connection("o_assets").where({ id: payload.targetId, projectId: payload.projectId }).first(),
  ]);
  if (!project || !asset) throw new Error("资产不存在或不属于当前项目");
  const config = assetPromptConfig[asset.type as keyof typeof assetPromptConfig];
  if (!config) throw new Error("不支持的资产类型");
  const manualName = asset.assetsId ? config.derivativeManual : config.manual;
  const visualManual = dependencies.getArtPrompt(String(project.artStyle || "无"), "art_skills", manualName);
  if (!visualManual) throw new Error("视觉手册未定义");
  try {
    await markProviderSubmission(context, payload.operation);
    const response = await dependencies.invokeText("universalAi", {
      system: `${visualManual}\n${payload.otherTextPrompt}`,
      messages: [{
        role: "user",
        content: `${config.label}名称:${asset.name || "未命名"}\n${config.label}描述:${asset.describe || ""}`,
      }],
      abortSignal: context.signal,
    });
    const prompt = (response._output || response.text || "").trim();
    if (!prompt) throw new Error("资产提示词生成未返回结果");
    await connection("o_assets").where({ id: payload.targetId, projectId: payload.projectId }).update({
      prompt,
      promptState: "已完成",
      promptErrorReason: null,
    });
    return { result: { assetId: payload.targetId, prompt }, metering: unknownCostMetering(payload.model, response) };
  } catch (cause) {
    await connection("o_assets").where({ id: payload.targetId, projectId: payload.projectId }).update({
      promptState: "生成失败",
      promptErrorReason: errorMessage(cause).slice(0, 500),
    });
    throw cause;
  }
}

async function executeAssetAudio(
  payload: Extract<TextGenerationPayload, { operation: "asset_audio" }>,
  context: GenerationExecutionContext,
  dependencies: Required<CoreTextExecutorDependencies>,
): Promise<GenerationExecutionResult<unknown>> {
  const { connection } = dependencies;
  const [asset, audioRows, promptRow] = await Promise.all([
    connection("o_assets").where({ id: payload.targetId, projectId: payload.projectId }).first(),
    connection("o_assets").where({ projectId: payload.projectId, type: "audio" }).whereNull("assetsId").select("id", "name", "describe"),
    connection("o_prompt").where({ type: "audioBindPrompt" }).first(),
  ]);
  if (!asset) throw new Error("资产不存在或不属于当前项目");
  if (audioRows.length === 0) throw new Error("暂无可匹配的音频");
  let selectedAudioId: number | null = null;
  const resultTool = tool({
    description: "提交匹配的音频 ID",
    inputSchema: jsonSchema(z.object({ audioId: z.number().int().positive().nullable() }).toJSONSchema()),
    execute: async (result: any) => {
      selectedAudioId = result.audioId == null ? null : Number(result.audioId);
      return "已记录";
    },
  });
  try {
    const audioList = audioRows.map((item: any) => `ID:${item.id} 名称:${item.name} 描述:${item.describe || "无"}`).join("\n");
    await markProviderSubmission(context, payload.operation);
    const response = await dependencies.invokeText("universalAi", {
      messages: [
        { role: "system", content: promptRow?.useData || promptRow?.data || "匹配最合适的音频" },
        { role: "user", content: `候选音频列表\n${audioList}\n待匹配资产：${asset.name || "未命名"} ${asset.describe || ""}` },
      ],
      tools: { resultTool },
      abortSignal: context.signal,
    });
    if (selectedAudioId !== null && !audioRows.some((item: any) => Number(item.id) === selectedAudioId)) {
      throw new Error("模型返回了无效的音频 ID");
    }
    await connection.transaction(async (trx: Knex.Transaction) => {
      await trx("o_assetsRole2Audio").where({ assetsRoleId: payload.targetId }).delete();
      if (selectedAudioId !== null) {
        await trx("o_assetsRole2Audio").insert({ assetsRoleId: payload.targetId, assetsAudioId: selectedAudioId });
      }
      await trx("o_assets").where({ id: payload.targetId, projectId: payload.projectId }).update({ audioBindState: "已完成" });
    });
    return { result: { assetId: payload.targetId, audioId: selectedAudioId }, metering: unknownCostMetering(payload.model, response) };
  } catch (cause) {
    await connection("o_assets").where({ id: payload.targetId, projectId: payload.projectId }).update({ audioBindState: "生成失败" });
    throw cause;
  }
}

const newAssetSchema = z.object({ name: z.string(), desc: z.string(), type: z.enum(["role", "tool", "scene"]), scriptIds: z.array(z.number()) });
const existingAssetSchema = z.object({ name: z.string(), scriptIds: z.array(z.number()) });

async function executeScriptAssets(
  payload: Extract<TextGenerationPayload, { operation: "script_assets" }>,
  context: GenerationExecutionContext,
  dependencies: Required<CoreTextExecutorDependencies>,
): Promise<GenerationExecutionResult<unknown>> {
  const { connection } = dependencies;
  const [script, existingAssets, promptRow] = await Promise.all([
    connection("o_script").where({ id: payload.targetId, projectId: payload.projectId }).first(),
    connection("o_assets").where({ projectId: payload.projectId }).select("id", "name", "type"),
    connection("o_prompt").where({ type: "scriptAssetExtraction" }).first(),
  ]);
  if (!script) throw new Error("剧本不存在或不属于当前项目");
  let newAssets: Array<z.infer<typeof newAssetSchema>> = [];
  let existingRefs: Array<z.infer<typeof existingAssetSchema>> = [];
  const resultTool = tool({
    description: "提交剧本资产提取结果",
    inputSchema: jsonSchema(z.object({
      newAssets: z.array(newAssetSchema),
      existingAssetRefs: z.array(existingAssetSchema),
    }).toJSONSchema()),
    execute: async (result: any) => {
      newAssets = result.newAssets || [];
      existingRefs = result.existingAssetRefs || [];
      return "已记录";
    },
  });
  try {
    const existingList = existingAssets.map((asset: any) => `${asset.name}(${asset.type})`).join("、");
    await markProviderSubmission(context, payload.operation);
    const response = await dependencies.invokeText("universalAi", {
      messages: [
        { role: "system", content: promptRow?.useData || promptRow?.data || "提取角色、场景和道具，并调用工具提交" },
        { role: "user", content: `已有资产：${existingList}\n剧本：${script.content || ""}` },
      ],
      tools: { resultTool },
      abortSignal: context.signal,
    });
    if (newAssets.length === 0 && existingRefs.length === 0) throw new Error("AI 未返回任何资产");

    let assetCount = 0;
    await connection.transaction(async (trx: Knex.Transaction) => {
      const before = await trx("o_assets").where({ projectId: payload.projectId }).select("id", "name");
      const existingNames = new Set(before.map((asset: any) => String(asset.name)));
      const inserts = newAssets
        .filter((asset) => !existingNames.has(asset.name))
        .map((asset) => ({ name: asset.name, type: asset.type, describe: asset.desc, projectId: payload.projectId, startTime: Date.now() }));
      if (inserts.length > 0) await trx("o_assets").insert(inserts);
      const allAssets = await trx("o_assets").where({ projectId: payload.projectId }).select("id", "name");
      const byName = new Map(allAssets.map((asset: any) => [String(asset.name), Number(asset.id)]));
      const names = [...new Set([...newAssets.map((asset) => asset.name), ...existingRefs.map((asset) => asset.name)])];
      const rows = names.map((name) => byName.get(name)).filter((id): id is number => id !== undefined).map((assetId) => ({ scriptId: payload.targetId, assetId }));
      await trx("o_scriptAssets").where({ scriptId: payload.targetId }).delete();
      if (rows.length > 0) await trx("o_scriptAssets").insert(rows);
      await trx("o_script").where({ id: payload.targetId, projectId: payload.projectId }).update({ extractState: 1, errorReason: null });
      assetCount = rows.length;
    });
    return { result: { scriptId: payload.targetId, assetCount }, metering: unknownCostMetering(payload.model, response) };
  } catch (cause) {
    await connection("o_script").where({ id: payload.targetId, projectId: payload.projectId }).update({ extractState: -1, errorReason: errorMessage(cause).slice(0, 500) });
    throw cause;
  }
}

async function executeAiRegex(
  payload: Extract<TextGenerationPayload, { operation: "ai_regex" }>,
  context: GenerationExecutionContext,
  dependencies: Required<CoreTextExecutorDependencies>,
): Promise<GenerationExecutionResult<unknown>> {
  await markProviderSubmission(context, payload.operation);
  const response = await dependencies.invokeText("universalAi", {
    system: "你是一个正则表达式专家。分析剧本集数与标题分隔模式，只返回带 g 标志且包含编号和标题两个捕获组的 JavaScript 正则表达式；无明显模式返回空字符串。",
    messages: [{ role: "user", content: payload.content }],
    abortSignal: context.signal,
  });
  return { result: { regex: (response.text || "").trim() }, metering: unknownCostMetering(payload.model, response) };
}

async function executeNovelEvents(
  payload: Extract<TextGenerationPayload, { operation: "novel_events" }>,
  connection: ExecutorConnection,
): Promise<GenerationExecutionResult<unknown>> {
  const chapter = await connection("o_novel").where({ id: payload.targetId, projectId: payload.projectId }).first();
  if (!chapter) throw new Error("小说章节不存在");

  const cleaner = new u.cleanNovel(1);
  const results = await cleaner.start([chapter], payload.projectId);
  const result = results[0];
  if (!result?.event) {
    await connection("o_novel").where({ id: payload.targetId }).update({
      eventState: -1,
      errorReason: "事件提取失败",
    });
    throw new Error("小说章节事件提取失败");
  }
  await connection("o_novel").where({ id: payload.targetId, projectId: payload.projectId }).update({
    event: result.event,
    eventState: 1,
    errorReason: null,
  });
  return { result, metering: unknownCostMetering(payload.model) };
}

async function executeVideoPrompt(
  payload: Extract<TextGenerationPayload, { operation: "video_prompt" }>,
  context: GenerationExecutionContext,
  dependencies: Required<CoreTextExecutorDependencies>,
): Promise<GenerationExecutionResult<unknown>> {
  const { connection, getPath, readFile, getArtPrompt, invokeText } = dependencies;
  const track = await connection("o_videoTrack")
    .where({ id: payload.targetId, projectId: payload.projectId })
    .select("id")
    .first();
  if (!track) throw new Error("视频轨道不存在或不属于当前项目");

  try {
    const project = await connection("o_project")
      .where({ id: payload.projectId })
      .select("id", "artStyle")
      .first();
    if (!project) throw new Error("项目不存在");

    const assets: any[] = [];
    const storyboards: any[] = [];
    for (const reference of payload.references) {
      if (reference.kind === "asset") {
        const asset = await connection("o_assets")
          .leftJoin("o_image", "o_image.id", "o_assets.imageId")
          .where("o_assets.id", reference.id)
          .where("o_assets.projectId", payload.projectId)
          .select("o_assets.id", "o_assets.type", "o_assets.name", "o_image.filePath")
          .first();
        if (!asset) throw new Error("提示词资产引用不存在或不属于当前项目");
        assets.push(asset);
        continue;
      }

      const storyboard = await connection("o_storyboard")
        .where({ id: reference.id, projectId: payload.projectId })
        .select("id", "videoDesc", "prompt", "track", "duration", "shouldGenerateImage")
        .first();
      if (!storyboard) throw new Error("提示词分镜引用不存在或不属于当前项目");
      const assetRows = await connection("o_assets2Storyboard")
        .where({ storyboardId: reference.id })
        .orderBy("rowid")
        .select("assetId");
      storyboards.push({
        ...storyboard,
        associateAssetsIds: assetRows.map((row: any) => Number(row.assetId)),
      });
    }

    const audioAssetIds = assets.filter((asset) => asset.type === "audio").map((asset) => Number(asset.id));
    const audioRows = audioAssetIds.length === 0
      ? []
      : await connection("o_assets")
        .whereIn("o_assets.id", audioAssetIds)
        .join("o_assetsRole2Audio", "o_assetsRole2Audio.assetsAudioId", "o_assets.assetsId")
        .select("o_assets.id", "o_assetsRole2Audio.assetsRoleId");
    const audioByRole = new Map<number, number>();
    for (const row of audioRows) audioByRole.set(Number(row.assetsRoleId), Number(row.id));

    const [vendorId, parsedModelName] = payload.videoModel.split(/:(.+)/);
    const modelName = parsedModelName || payload.videoModel;
    const promptRoot = path.resolve(getPath(["modelPrompt"]));
    let systemPrompt: string | undefined;
    const modelPrompt = await connection("o_modelPrompt")
      .where({ vendorId, model: modelName })
      .select("path")
      .first();
    if (modelPrompt?.path) {
      const boundPromptPath = path.resolve(promptRoot, String(modelPrompt.path));
      if (isPathInside(boundPromptPath, promptRoot)) {
        systemPrompt = await tryReadTemplate(readFile, boundPromptPath);
      }
    }
    if (!systemPrompt) {
      const automaticFile = automaticVideoPromptFile(modelName, payload.mode);
      if (automaticFile) {
        systemPrompt = await tryReadTemplate(readFile, path.join(promptRoot, "video", automaticFile));
      }
    }
    if (!systemPrompt) {
      const fallbackPrompt = await connection("o_prompt")
        .where({ type: "videoPromptGeneration" })
        .select("useData", "data")
        .first();
      systemPrompt = fallbackPrompt?.useData || fallbackPrompt?.data || undefined;
    }

    const visualManual = getArtPrompt(project.artStyle || "无", "art_skills", "art_storyboard_video");
    const structuredPromptData = {
      model: modelName,
      assets: assets
      .filter((asset) => asset.filePath)
        .map((asset) => ({
          id: Number(asset.id),
          type: String(asset.type || ""),
          name: String(asset.name || ""),
          audioAssetId: audioByRole.get(Number(asset.id)) ?? null,
        })),
      storyboards: storyboards.map((storyboard) => ({
        id: Number(storyboard.id),
        videoDesc: String(storyboard.videoDesc || ""),
        prompt: String(storyboard.prompt || ""),
        track: String(storyboard.track || ""),
        duration: String(storyboard.duration || ""),
        associateAssetsIds: storyboard.associateAssetsIds,
        shouldGenerateImage: Number(storyboard.shouldGenerateImage) !== 0,
      })),
    };
    const content = JSON.stringify(structuredPromptData);
    await context.setProviderRequestId(`video-prompt:${context.jobId}`);
    const response = await invokeText("universalAi", {
      system: systemPrompt,
      messages: [
        { role: "assistant", content: visualManual },
        { role: "user", content },
      ],
    });
    const { text } = response;
    if (!text) throw new Error("视频提示词生成失败：模型未返回内容");

    await connection("o_videoTrack").where({ id: payload.targetId, projectId: payload.projectId }).update({
      state: "已完成",
      prompt: text,
      reason: null,
    });
    return {
      result: { trackId: payload.targetId, prompt: text },
      metering: unknownCostMetering(payload.model, response),
    };
  } catch (cause) {
    await connection("o_videoTrack").where({ id: payload.targetId, projectId: payload.projectId }).update({
      state: "生成失败",
      reason: errorMessage(cause),
    });
    throw cause;
  }
}

export async function executeCoreTextGeneration(
  payload: TextGenerationPayload,
  context: GenerationExecutionContext,
  overrides: CoreTextExecutorDependencies = {},
): Promise<GenerationExecutionResult<unknown>> {
  const dependencies: Required<CoreTextExecutorDependencies> = {
    connection: overrides.connection ?? u.db,
    getPath: overrides.getPath ?? ((segments) => u.getPath(segments)),
    readFile: overrides.readFile ?? ((filePath) => fs.readFile(filePath, "utf-8")),
    getArtPrompt: overrides.getArtPrompt ?? ((styleName, source, fileName) => u.getArtPrompt(styleName, source, fileName)),
    getImageBase64: overrides.getImageBase64 ?? ((imagePath) => u.oss.getImageBase64(imagePath)),
    invokeText: overrides.invokeText ?? ((model, input) => u.Ai.Text(model).invoke(input as any)),
  };

  if (payload.operation === "novel_events") return executeNovelEvents(payload, dependencies.connection);
  if (payload.operation === "video_prompt") return executeVideoPrompt(payload, context, dependencies);
  if (payload.operation === "style_prompt") return executeStylePrompt(payload, context, dependencies);
  if (payload.operation === "asset_prompt") return executeAssetPrompt(payload, context, dependencies);
  if (payload.operation === "asset_audio") return executeAssetAudio(payload, context, dependencies);
  if (payload.operation === "script_assets") return executeScriptAssets(payload, context, dependencies);
  if (payload.operation === "ai_regex") return executeAiRegex(payload, context, dependencies);
  if (payload.operation === "script_agent" || payload.operation === "production_agent") {
    return executeQueuedAgent(payload, context);
  }
  throw new Error("尚未接入的文本任务类型");
}
