import fs from "fs/promises";
import path from "path";
import isPathInside from "is-path-inside";
import type { Knex } from "knex";
import u from "@/utils";
import type { GenerationExecutionContext, GenerationExecutionResult } from "@/types/generationQueue";
import type { TextGenerationPayload } from "@/jobs/handlers/textGeneration";

type ExecutorConnection = Knex | Knex.Transaction;

interface TextInvocationInput {
  system?: string;
  messages: Array<{ role: "assistant" | "user"; content: string }>;
}

export interface CoreTextExecutorDependencies {
  connection?: ExecutorConnection;
  getPath?: (segments: string[]) => string;
  readFile?: (filePath: string) => Promise<string>;
  getArtPrompt?: (styleName: string, source: string, fileName: string) => string;
  invokeText?: (model: "universalAi", input: TextInvocationInput) => Promise<{ text: string }>;
}

function unknownCostMetering(modelId: string) {
  return {
    providerId: null,
    modelId,
    units: {},
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
    const { text } = await invokeText("universalAi", {
      system: systemPrompt,
      messages: [
        { role: "assistant", content: visualManual },
        { role: "user", content },
      ],
    });
    if (!text) throw new Error("视频提示词生成失败：模型未返回内容");

    await connection("o_videoTrack").where({ id: payload.targetId, projectId: payload.projectId }).update({
      state: "已完成",
      prompt: text,
      reason: null,
    });
    return {
      result: { trackId: payload.targetId, prompt: text },
      metering: unknownCostMetering(payload.model),
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
    invokeText: overrides.invokeText ?? ((model, input) => u.Ai.Text(model).invoke(input)),
  };

  if (payload.operation === "novel_events") return executeNovelEvents(payload, dependencies.connection);
  if (payload.operation === "video_prompt") return executeVideoPrompt(payload, context, dependencies);
  throw new Error(`尚未接入的文本任务类型: ${payload.operation}`);
}
