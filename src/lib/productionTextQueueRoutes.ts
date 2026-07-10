import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import type { AuthUser } from "@/types/auth";
import type { QueuedWorkflowItem } from "@/services/generationWorkflows";

export interface StylePromptQueueInput { projectId: number; images: string[] }
export interface AssetPromptQueueInput { projectId: number; assetIds: number[]; otherTextPrompt: string }
export interface AssetAudioQueueInput { projectId: number; assetIds: number[] }
export interface ScriptAssetsQueueInput { projectId: number; scriptIds: number[] }
export interface AiRegexQueueInput { projectId: number; content: string }

export type EnqueueProductionText<TInput> = (
  actor: AuthUser,
  input: TInput,
  requestId: string,
) => Promise<QueuedWorkflowItem[]>;

function requestId(req: express.Request): string {
  return String(req.headers["x-request-id"] || uuidv4());
}

function queuedResponse(items: QueuedWorkflowItem[], message: string, single: boolean) {
  return single
    ? { ...items[0], message }
    : { items, total: items.length, message };
}

function createQueueHandler<TInput>(
  enqueue: EnqueueProductionText<TInput>,
  mapInput: (body: any) => TInput,
  message: string,
  single: boolean,
): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const items = await enqueue((req as express.Request & { user: AuthUser }).user, mapInput(req.body), requestId(req));
      return res.status(200).send(success(queuedResponse(items, message, single)));
    } catch (cause) {
      if (cause && typeof cause === "object" && "status" in cause && "code" in cause && cause instanceof Error) {
        const serviceError = cause as Error & { status: number; code: string };
        return res.status(serviceError.status).send(error(serviceError.message, { code: serviceError.code }));
      }
      return next(cause);
    }
  };
}

export function createExtractStylePromptRouter(enqueue: EnqueueProductionText<StylePromptQueueInput>) {
  const router = express.Router();
  return router.post("/", validateFields({
    projectId: z.number().int().positive(),
    images: z.array(z.string().min(1)).min(1),
  }), createQueueHandler(enqueue, (body) => ({
    projectId: body.projectId,
    images: body.images,
  }), "已加入画风分析队列", true));
}

const polishItemSchema = z.object({
  assetsId: z.number().int().positive(),
  type: z.string(),
  name: z.string(),
  describe: z.string(),
});

export function createPolishAssetsPromptRouter(enqueue: EnqueueProductionText<AssetPromptQueueInput>) {
  const router = express.Router();
  return router.post("/", validateFields({
    assetsId: z.number().int().positive(),
    projectId: z.number().int().positive(),
    type: z.string(),
    name: z.string(),
    describe: z.string(),
  }), createQueueHandler(enqueue, (body) => ({
    projectId: body.projectId,
    assetIds: [body.assetsId],
    otherTextPrompt: "",
  }), "已加入资产提示词生成队列", true));
}

export function createBatchPolishAssetsPromptRouter(enqueue: EnqueueProductionText<AssetPromptQueueInput>) {
  const router = express.Router();
  return router.post("/", validateFields({
    items: z.array(polishItemSchema).min(1),
    projectId: z.number().int().positive(),
    concurrentCount: z.number().int().positive().optional(),
    otherTextPrompt: z.string(),
  }), createQueueHandler(enqueue, (body) => ({
    projectId: body.projectId,
    assetIds: body.items.map((item: any) => item.assetsId),
    otherTextPrompt: body.otherTextPrompt,
  }), "已加入资产提示词生成队列", false));
}

export function createBatchBindAudioRouter(enqueue: EnqueueProductionText<AssetAudioQueueInput>) {
  const router = express.Router();
  return router.post("/", validateFields({
    projectId: z.number().int().positive(),
    assetsIds: z.array(z.number().int().positive()).min(1),
    concurrentCount: z.number().int().positive().optional(),
  }), createQueueHandler(enqueue, (body) => ({
    projectId: body.projectId,
    assetIds: body.assetsIds,
  }), "已加入音频匹配队列", false));
}

export function createExtractAssetsRouter(enqueue: EnqueueProductionText<ScriptAssetsQueueInput>) {
  const router = express.Router();
  return router.post("/", validateFields({
    projectId: z.number().int().positive(),
    scriptIds: z.array(z.number().int().positive()).min(1),
    groupSize: z.number().int().positive().optional(),
  }), createQueueHandler(enqueue, (body) => ({
    projectId: body.projectId,
    scriptIds: body.scriptIds,
  }), "已加入剧本资产提取队列", false));
}

export function createGetAiRegexRouter(enqueue: EnqueueProductionText<AiRegexQueueInput>) {
  const router = express.Router();
  return router.post("/", validateFields({
    projectId: z.number().int().positive(),
    content: z.string().min(1),
  }), createQueueHandler(enqueue, (body) => ({
    projectId: body.projectId,
    content: body.content,
  }), "已加入剧本格式分析队列", true));
}
