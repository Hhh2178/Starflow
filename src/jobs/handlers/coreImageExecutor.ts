import { v4 as uuidv4 } from "uuid";
import u from "@/utils";
import type { GenerationExecutionResult } from "@/types/generationQueue";
import type { ImageGenerationPayload } from "@/jobs/handlers/imageGeneration";

const assetDirectories: Record<string, string> = { role: "role", scene: "scene", tool: "props" };

export async function executeCoreImageGeneration(
  payload: ImageGenerationPayload,
): Promise<GenerationExecutionResult<unknown>> {
  if (payload.operation === "edit") throw new Error(`尚未接入的图片任务类型: ${payload.operation}`);
  const target = payload.operation === "asset"
    ? await u.db("o_image")
      .join("o_assets", "o_assets.id", "o_image.assetsId")
      .where("o_image.id", payload.targetId)
      .where("o_assets.projectId", payload.projectId)
      .select("o_image.*", "o_assets.projectId")
      .first()
    : await u.db("o_storyboard")
      .where({ id: payload.targetId, projectId: payload.projectId })
      .first();
  if (!target) throw new Error(payload.operation === "asset" ? "图片占位记录不存在" : "分镜不存在");

  try {
    const references = payload.referenceResourceIds.length === 0
      ? []
      : await u.db("o_image")
        .join("o_assets", "o_assets.id", "o_image.assetsId")
        .whereIn("o_image.id", payload.referenceResourceIds)
        .where("o_assets.projectId", payload.projectId)
        .whereNotNull("o_image.filePath")
        .select("o_image.filePath");
    if (references.length !== payload.referenceResourceIds.length) throw new Error("参考图片已失效或不属于当前项目");
    const referenceList = await Promise.all(references.map(async (reference: any) => ({
      type: "image" as const,
      base64: await u.oss.getImageBase64(String(reference.filePath)),
    })));
    const directory = payload.operation === "asset" ? assetDirectories[String(target.type)] || "assets" : "storyboard";
    const imagePath = `/${payload.projectId}/${directory}/${uuidv4()}.jpg`;
    const aiImage = u.Ai.Image(payload.model as `${string}:${string}`);
    await aiImage.run({
      prompt: payload.prompt,
      referenceList,
      size: payload.size,
      aspectRatio: payload.aspectRatio as `${number}:${number}`,
    });
    await aiImage.save(imagePath);
    if (payload.operation === "asset") {
      await u.db("o_image").where({ id: payload.targetId }).update({ state: "已完成", filePath: imagePath, errorReason: null });
    } else {
      await u.db("o_storyboard").where({ id: payload.targetId }).update({ state: "已完成", filePath: imagePath, reason: null });
    }
    return {
      result: { imageId: payload.targetId, path: await u.oss.getSmallImageUrl(imagePath) },
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
      await u.db("o_image").where({ id: payload.targetId }).update({ state: "生成失败", errorReason: message });
    } else {
      await u.db("o_storyboard").where({ id: payload.targetId }).update({ state: "生成失败", reason: message, filePath: "" });
    }
    throw error;
  }
}
