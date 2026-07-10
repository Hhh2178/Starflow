import u from "@/utils";
import type { GenerationExecutionResult } from "@/types/generationQueue";
import type { TextGenerationPayload } from "@/jobs/handlers/textGeneration";

export async function executeCoreTextGeneration(
  payload: TextGenerationPayload,
): Promise<GenerationExecutionResult<unknown>> {
  if (payload.operation !== "novel_events") throw new Error(`尚未接入的文本任务类型: ${payload.operation}`);
  const chapter = await u.db("o_novel").where({ id: payload.targetId, projectId: payload.projectId }).first();
  if (!chapter) throw new Error("小说章节不存在");

  const cleaner = new u.cleanNovel(1);
  const results = await cleaner.start([chapter], payload.projectId);
  const result = results[0];
  if (!result?.event) {
    await u.db("o_novel").where({ id: payload.targetId }).update({
      eventState: -1,
      errorReason: "事件提取失败",
    });
    throw new Error("小说章节事件提取失败");
  }
  await u.db("o_novel").where({ id: payload.targetId, projectId: payload.projectId }).update({
    event: result.event,
    eventState: 1,
    errorReason: null,
  });
  return {
    result,
    metering: {
      providerId: null,
      modelId: payload.model,
      units: {},
      estimatedCost: null,
      currency: null,
      pricingSnapshot: {},
      providerRequestId: null,
    },
  };
}
