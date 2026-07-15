import u from "@/utils";
import type { GenerationExecutionContext, GenerationExecutionResult, ReferenceList } from "@/types/generationQueue";
import type { VideoGenerationPayload } from "@/jobs/handlers/videoGeneration";
import { runWithVideoSubmissionMarker } from "@/jobs/handlers/videoSubmissionBoundary";

export async function executeCoreVideoGeneration(
  payload: VideoGenerationPayload,
  context: GenerationExecutionContext,
): Promise<GenerationExecutionResult<unknown>> {
  const video = await u.db("o_video").where({ id: payload.targetId, projectId: payload.projectId }).first();
  if (!video?.filePath) throw new Error("视频占位记录不存在");
  try {
    const referenceList = [] as Array<{ type: "image" | "audio" | "video"; base64: string }>;
    for (const reference of payload.referenceResources) {
      const resource = reference.kind === "asset"
        ? await u.db("o_assets")
          .join("o_image", "o_image.id", "o_assets.imageId")
          .where("o_assets.id", reference.id)
          .where("o_assets.projectId", payload.projectId)
          .select("o_image.filePath", "o_assets.type")
          .first()
        : await u.db("o_storyboard")
          .where({ id: reference.id, projectId: payload.projectId })
          .select("filePath")
          .first();
      if (!resource?.filePath) throw new Error("视频参考资源已失效");
      const type = resource.type === "audio" ? "audio" : resource.type === "video" ? "video" : "image";
      referenceList.push({ type, base64: await u.oss.getImageBase64(String(resource.filePath)) });
    }
    let mode: unknown = payload.mode;
    if (typeof mode === "string" && mode.startsWith("[")) {
      try { mode = JSON.parse(mode); } catch { /* 使用原始模式 */ }
    }
    const aiVideo = u.Ai.Video(payload.model as `${string}:${string}`);
    await runWithVideoSubmissionMarker(context, () => aiVideo.run({
      prompt: payload.prompt,
      referenceList: referenceList as ReferenceList[],
      mode: mode as any,
      duration: payload.duration,
      aspectRatio: payload.aspectRatio,
      resolution: payload.resolution,
      audio: payload.audio,
    }));
    await aiVideo.save(String(video.filePath));
    await u.db("o_video").where({ id: payload.targetId }).update({ state: "已完成", errorReason: null });
    return {
      result: { videoId: payload.targetId, path: video.filePath },
      metering: {
        providerId: payload.model.split(/:(.+)/)[0] || null,
        modelId: payload.model,
        units: { requests: 1, seconds: payload.duration },
        estimatedCost: null,
        currency: null,
        pricingSnapshot: {},
        providerRequestId: null,
      },
    };
  } catch (error) {
    await u.db("o_video").where({ id: payload.targetId }).update({
      state: "生成失败",
      errorReason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    throw error;
  }
}
