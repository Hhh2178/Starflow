import express, { type RequestHandler } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import {
  enqueueVideoPromptJobs,
  type EnqueueVideoPromptsInput,
  type QueuedWorkflowItem,
} from "@/services/generationWorkflows";
import type { AuthUser } from "@/types/auth";

type EnqueueVideoPrompts = (
  actor: AuthUser,
  input: EnqueueVideoPromptsInput,
  requestId: string,
) => Promise<QueuedWorkflowItem[]>;

const referenceSchema = z.object({
  id: z.number().int().positive(),
  sources: z.enum(["assets", "storyboard"]),
});

export function createGenerateVideoPromptHandler(
  enqueue: EnqueueVideoPrompts = enqueueVideoPromptJobs,
): RequestHandler {
  return async (req, res) => {
    const requestId = String(req.headers["x-request-id"] || uuidv4());
    const [item] = await enqueue(getAuthUser(req), {
      projectId: req.body.projectId,
      videoModel: req.body.model,
      mode: req.body.mode,
      tracks: [{
        trackId: req.body.trackId,
        references: req.body.info.map((reference: any) => ({
          kind: reference.sources === "assets" ? "asset" as const : "storyboard" as const,
          id: reference.id,
        })),
      }],
    }, requestId);
    return res.status(200).send(success({ ...item, message: "已加入视频提示词生成队列" }));
  };
}

export function createGenerateVideoPromptRouter(
  enqueue: EnqueueVideoPrompts = enqueueVideoPromptJobs,
) {
  const router = express.Router();
  return router.post(
    "/",
    validateFields({
      trackId: z.number().int().positive(),
      projectId: z.number().int().positive(),
      info: z.array(referenceSchema),
      model: z.string().min(1),
      mode: z.string().min(1),
      concurrentCount: z.number().int().positive().optional(),
    }),
    createGenerateVideoPromptHandler(enqueue),
  );
}

export default createGenerateVideoPromptRouter();
