import express, { type RequestHandler } from "express";
import { z, type ZodTypeAny } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import {
  enqueueVideoPromptJobs,
  type EnqueueVideoPromptsInput,
  type QueuedWorkflowItem,
} from "@/services/generationWorkflows";
import type { AuthUser } from "@/types/auth";

export type VideoPromptRouteMode = "single" | "batch";

export type EnqueueVideoPrompts = (
  actor: AuthUser,
  input: EnqueueVideoPromptsInput,
  requestId: string,
) => Promise<QueuedWorkflowItem[]>;

const referenceSchema = z.object({
  id: z.number().int().positive(),
  sources: z.enum(["assets", "storyboard"]),
});

const commonBodyShape = {
  projectId: z.number().int().positive(),
  mode: z.string().min(1),
  model: z.string().min(1),
  concurrentCount: z.number().int().positive().optional(),
};

const bodyShapes: Record<VideoPromptRouteMode, Record<string, ZodTypeAny>> = {
  single: {
    ...commonBodyShape,
    trackId: z.number().int().positive(),
    info: z.array(referenceSchema),
  },
  batch: {
    ...commonBodyShape,
    trackData: z.array(z.object({
      trackId: z.number().int().positive(),
      info: z.array(referenceSchema),
    })).min(1),
  },
};

function mapReferences(info: Array<{ id: number; sources: "assets" | "storyboard" }>) {
  return info.map((reference) => ({
    kind: reference.sources === "assets" ? "asset" as const : "storyboard" as const,
    id: reference.id,
  }));
}

function mapWorkflowInput(mode: VideoPromptRouteMode, body: any): EnqueueVideoPromptsInput {
  const tracks = mode === "single"
    ? [{ trackId: body.trackId, references: mapReferences(body.info) }]
    : body.trackData.map((track: any) => ({
      trackId: track.trackId,
      references: mapReferences(track.info),
    }));
  return {
    projectId: body.projectId,
    videoModel: body.model,
    mode: body.mode,
    tracks,
  };
}

export function createVideoPromptQueueHandler(
  mode: VideoPromptRouteMode,
  enqueue: EnqueueVideoPrompts = enqueueVideoPromptJobs,
): RequestHandler {
  return async (req, res) => {
    try {
      const requestId = String(req.headers["x-request-id"] || uuidv4());
      const items = await enqueue(getAuthUser(req), mapWorkflowInput(mode, req.body), requestId);
      const data = mode === "single"
        ? { ...items[0], message: "已加入视频提示词生成队列" }
        : { items, total: items.length, message: "已加入视频提示词生成队列" };
      return res.status(200).send(success(data));
    } catch (cause) {
      return sendAdminServiceError(res, cause);
    }
  };
}

export function createVideoPromptQueueRouter(
  mode: VideoPromptRouteMode,
  enqueue: EnqueueVideoPrompts = enqueueVideoPromptJobs,
) {
  const router = express.Router();
  return router.post(
    "/",
    validateFields(bodyShapes[mode]),
    createVideoPromptQueueHandler(mode, enqueue),
  );
}
