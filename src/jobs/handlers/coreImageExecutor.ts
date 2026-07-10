import { v4 as uuidv4 } from "uuid";
import type { Knex } from "knex";
import u from "@/utils";
import type { GenerationExecutionContext, GenerationExecutionResult } from "@/types/generationQueue";
import type { ImageGenerationPayload } from "@/jobs/handlers/imageGeneration";

const assetDirectories: Record<string, string> = { role: "role", scene: "scene", tool: "props" };

type ImageConnection = Knex | Knex.Transaction;
type ImageInput = { prompt: string; referenceList: Array<{ type: "image"; base64: string }>; size: "1K" | "2K" | "4K"; aspectRatio: `${number}:${number}` };
export interface CoreImageExecutorDependencies {
  connection?: ImageConnection;
  getImageBase64?: (path: string) => Promise<string>;
  runImage?: (model: string, input: ImageInput) => Promise<{ save(path: string): Promise<void> }>;
  getSmallImageUrl?: (path: string) => Promise<string>;
  createId?: () => string;
}

export async function executeCoreImageGeneration(
  payload: ImageGenerationPayload,
  context: GenerationExecutionContext,
  overrides: CoreImageExecutorDependencies = {},
): Promise<GenerationExecutionResult<unknown>> {
  const connection = overrides.connection ?? u.db;
  const getImageBase64 = overrides.getImageBase64 ?? ((path) => u.oss.getImageBase64(path));
  const runImage = overrides.runImage ?? (async (model, input) => {
    const image = u.Ai.Image(model as `${string}:${string}`);
    await image.run(input);
    return { save: (path: string) => image.save(path) };
  });
  const getSmallImageUrl = overrides.getSmallImageUrl ?? ((path) => u.oss.getSmallImageUrl(path));
  const createId = overrides.createId ?? uuidv4;

  if (payload.operation === "edit") {
    const project = await connection("o_project").where({ id: payload.projectId }).select("id").first();
    if (!project) throw new Error("项目不存在");
    const referenceList = await Promise.all(payload.referencePaths.map(async (referencePath) => ({
      type: "image" as const,
      base64: await getImageBase64(referencePath),
    })));
    const imagePath = `/${payload.projectId}/workFlow/${createId()}.jpg`;
    await context.setProviderRequestId(`image:${context.jobId}`);
    const image = await runImage(payload.model, { prompt: payload.prompt, referenceList, size: payload.size, aspectRatio: payload.aspectRatio as `${number}:${number}` });
    await image.save(imagePath);
    return {
      result: { imageId: payload.targetId, path: await getSmallImageUrl(imagePath) },
      metering: { providerId: payload.model.split(/:(.+)/)[0] || null, modelId: payload.model, units: { images: 1 }, estimatedCost: null, currency: null, pricingSnapshot: {}, providerRequestId: null },
    };
  }
  const target = payload.operation === "asset"
    ? await connection("o_image")
      .join("o_assets", "o_assets.id", "o_image.assetsId")
      .where("o_image.id", payload.targetId)
      .where("o_assets.projectId", payload.projectId)
      .select("o_image.*", "o_assets.projectId")
      .first()
    : await connection("o_storyboard")
      .where({ id: payload.targetId, projectId: payload.projectId })
      .first();
  if (!target) throw new Error(payload.operation === "asset" ? "图片占位记录不存在" : "分镜不存在");

  try {
    const references = payload.referenceResourceIds.length === 0
      ? []
      : await connection("o_image")
        .join("o_assets", "o_assets.id", "o_image.assetsId")
        .whereIn("o_image.id", payload.referenceResourceIds)
        .where("o_assets.projectId", payload.projectId)
        .whereNotNull("o_image.filePath")
        .select("o_image.filePath");
    if (references.length !== payload.referenceResourceIds.length) throw new Error("参考图片已失效或不属于当前项目");
    const referenceList = await Promise.all(references.map(async (reference: any) => ({
      type: "image" as const,
      base64: await getImageBase64(String(reference.filePath)),
    })));
    const directory = payload.operation === "asset" ? assetDirectories[String(target.type)] || "assets" : "storyboard";
    const imagePath = `/${payload.projectId}/${directory}/${createId()}.jpg`;
    await context.setProviderRequestId(`image:${context.jobId}`);
    const aiImage = await runImage(payload.model, {
      prompt: payload.prompt,
      referenceList,
      size: payload.size,
      aspectRatio: payload.aspectRatio as `${number}:${number}`,
    });
    await aiImage.save(imagePath);
    if (payload.operation === "asset") {
      await connection("o_image").where({ id: payload.targetId }).update({ state: "已完成", filePath: imagePath, errorReason: null });
    } else {
      await connection("o_storyboard").where({ id: payload.targetId }).update({ state: "已完成", filePath: imagePath, reason: null });
    }
    return {
      result: { imageId: payload.targetId, path: await getSmallImageUrl(imagePath) },
      metering: {
        providerId: payload.model.split(/:(.+)/)[0] || null,
        modelId: payload.model,
        units: { images: 1 },
        estimatedCost: null,
        currency: null,
        pricingSnapshot: {},
        providerRequestId: null,
      },
    };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (payload.operation === "asset") {
      await connection("o_image").where({ id: payload.targetId }).update({ state: "生成失败", errorReason: message });
    } else {
      await connection("o_storyboard").where({ id: payload.targetId }).update({ state: "生成失败", reason: message, filePath: "" });
    }
    throw error;
  }
}
