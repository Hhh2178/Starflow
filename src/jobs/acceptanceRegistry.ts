import type { Knex } from "knex";
import { createGenerationJobRegistry } from "@/jobs/registry";
import { createTextGenerationHandler, type TextGenerationPayload } from "@/jobs/handlers/textGeneration";
import { createImageGenerationHandler, type ImageGenerationPayload } from "@/jobs/handlers/imageGeneration";
import { createVideoGenerationHandler, type VideoGenerationPayload } from "@/jobs/handlers/videoGeneration";
import { executeQueuedAgent } from "@/services/agentQueue";
import type { GenerationExecutionContext, GenerationExecutionResult, MeteringResult } from "@/types/generationQueue";
import fs from "node:fs/promises";
import path from "node:path";
import getPath from "@/utils/getPath";

export interface AcceptanceGenerationOptions {
  connection: Knex | Knex.Transaction;
  delayMs?: number;
}

function metering(model: string, type: "text" | "image" | "video"): MeteringResult {
  return {
    providerId: "acceptance",
    modelId: model,
    units: { [type]: 1 },
    estimatedCost: 0,
    currency: "CNY",
    pricingSnapshot: { source: "local-acceptance" },
    providerRequestId: null,
  };
}

function abortError(): Error {
  const error = new Error("验收任务已取消");
  error.name = "AbortError";
  return error;
}

async function waitForAcceptance(context: GenerationExecutionContext, delayMs: number, prompt: string): Promise<void> {
  await context.setProviderRequestId(`acceptance:${context.jobId}`);
  if (context.signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    context.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
  if (prompt.includes("[验收失败]")) throw new Error("验收任务按预期失败");
}

async function executeAcceptanceText(
  payload: TextGenerationPayload,
  context: GenerationExecutionContext,
  connection: Knex | Knex.Transaction,
  delayMs: number,
): Promise<GenerationExecutionResult<unknown>> {
  const acceptancePrompt = "prompt" in payload ? payload.prompt : "";
  await waitForAcceptance(context, delayMs, acceptancePrompt);
  if (payload.operation === "script_agent" || payload.operation === "production_agent") {
    const runAgent = async ({ socket, payload: agentPayload }: any) => {
      const messageId = `acceptance-message-${context.jobId}`;
      const contentId = `acceptance-content-${context.jobId}`;
      socket.emit("message", { id: messageId, role: "assistant", name: "本地验收助手", status: "pending", datetime: new Date().toISOString(), content: [] });
      socket.emit("content:add", { messageId, content: { id: contentId, type: "text", data: "", status: "pending" } });
      socket.emit("content:update", { messageId, contentId, type: "text", data: `已完成${agentPayload.operation === "script_agent" ? "剧本" : "制作"}验收任务。`, strategy: "append", status: "complete" });
      socket.emit("message:update", { id: messageId, status: "complete" });
    };
    return executeQueuedAgent(payload, context, {
      connection,
      runScriptAgent: runAgent,
      runProductionAgent: runAgent,
    });
  }

  if (payload.operation === "novel_events") {
    await connection("o_novel").where({ id: payload.targetId, projectId: payload.projectId }).update({ event: "本地验收事件", eventState: 1, errorReason: null });
    return { result: { event: "本地验收事件" }, metering: metering(payload.model, "text") };
  }
  if (payload.operation === "video_prompt") {
    const prompt = "本地验收视频提示词";
    await connection("o_videoTrack").where({ id: payload.targetId, projectId: payload.projectId }).update({ state: "已完成", prompt, reason: null });
    return { result: { trackId: payload.targetId, prompt }, metering: metering(payload.model, "text") };
  }
  if (payload.operation === "asset_prompt") {
    const prompt = "本地验收资产提示词";
    await connection("o_assets").where({ id: payload.targetId, projectId: payload.projectId }).update({ prompt, promptGenerateState: 1, errorReason: null });
    return { result: { assetId: payload.targetId, prompt }, metering: metering(payload.model, "text") };
  }
  if (payload.operation === "asset_audio") {
    await connection("o_assets").where({ id: payload.targetId, projectId: payload.projectId }).update({ audioBindState: "已完成" });
    return { result: { assetId: payload.targetId, audioId: null }, metering: metering(payload.model, "text") };
  }
  if (payload.operation === "script_assets") {
    await connection("o_script").where({ id: payload.targetId, projectId: payload.projectId }).update({ extractState: 1, errorReason: null });
    return { result: { scriptId: payload.targetId, assetCount: 0 }, metering: metering(payload.model, "text") };
  }
  if (payload.operation === "ai_regex") {
    return { result: { regex: "第(\\d+)集[：:]?(.+)" }, metering: metering(payload.model, "text") };
  }
  return { result: { prompt: "本地验收画风提示词" }, metering: metering(payload.model, "text") };
}

async function executeAcceptanceImage(
  payload: ImageGenerationPayload,
  context: GenerationExecutionContext,
  connection: Knex | Knex.Transaction,
  delayMs: number,
): Promise<GenerationExecutionResult<unknown>> {
  await waitForAcceptance(context, delayMs, payload.prompt);
  const filePath = `/acceptance/${payload.projectId}-${payload.targetId}.png`;
  const absolutePath = path.join(getPath("oss"), filePath.slice(1));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1sAAAAASUVORK5CYII=", "base64"));
  if (payload.operation === "asset") {
    await connection("o_image").where({ id: payload.targetId }).update({ state: "已完成", filePath, errorReason: null });
  } else if (payload.operation === "storyboard") {
    await connection("o_storyboard").where({ id: payload.targetId, projectId: payload.projectId }).update({ state: "已完成", filePath, reason: null });
  }
  return { result: { imageId: payload.targetId, path: `/oss${filePath}` }, metering: metering(payload.model, "image") };
}

async function executeAcceptanceVideo(
  payload: VideoGenerationPayload,
  context: GenerationExecutionContext,
  connection: Knex | Knex.Transaction,
  delayMs: number,
): Promise<GenerationExecutionResult<unknown>> {
  await waitForAcceptance(context, delayMs, payload.prompt);
  await connection("o_video").where({ id: payload.targetId, projectId: payload.projectId }).update({ state: "已完成", errorReason: null });
  const video = await connection("o_video").where({ id: payload.targetId, projectId: payload.projectId }).select("filePath").first();
  return { result: { videoId: payload.targetId, path: video?.filePath ?? null }, metering: metering(payload.model, "video") };
}

export function createAcceptanceGenerationRegistry(options: AcceptanceGenerationOptions) {
  const delayMs = Math.max(0, options.delayMs ?? 4_000);
  return createGenerationJobRegistry([
    createTextGenerationHandler((payload, context) => executeAcceptanceText(payload, context, options.connection, delayMs)),
    createImageGenerationHandler((payload, context) => executeAcceptanceImage(payload, context, options.connection, delayMs)),
    createVideoGenerationHandler((payload, context) => executeAcceptanceVideo(payload, context, options.connection, delayMs)),
  ]);
}
