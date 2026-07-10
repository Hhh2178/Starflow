import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { enqueueEditImageJob, type EnqueueEditImageInput, type QueuedWorkflowItem } from "@/services/generationWorkflows";
import type { AuthUser } from "@/types/auth";

type EnqueueEdit = (actor: AuthUser, input: EnqueueEditImageInput, requestId: string) => Promise<QueuedWorkflowItem>;

function localReferencePath(value: string): string | null {
  if (!value.startsWith("/oss/") || value.includes("..")) return null;
  const path = value.slice(4).replace("/smallImage", "");
  return path.startsWith("/") && !path.startsWith("//") ? path : null;
}

export function createGenerateFlowImageRouter(enqueue: EnqueueEdit = enqueueEditImageJob) {
  const router = express.Router();
  return router.post("/", validateFields({ model: z.string().min(1), references: z.array(z.string()).optional(), quality: z.enum(["1K", "2K", "4K"]), ratio: z.string().min(1), prompt: z.string(), projectId: z.number().int().positive() }), async (req, res) => {
    const referencePaths = (req.body.references ?? []).map(localReferencePath);
    if (referencePaths.some((path: string | null) => path === null)) return res.status(400).send(error("工作流图片只能引用已上传的本地文件"));
    try {
      const item = await enqueue(getAuthUser(req), { projectId: req.body.projectId, model: req.body.model, prompt: req.body.prompt, referencePaths: referencePaths as string[], size: req.body.quality, aspectRatio: req.body.ratio }, String(req.headers["x-request-id"] || uuidv4()));
      return res.status(200).send(success({ ...item, message: "已加入工作流图片生成队列" }));
    } catch (cause) { return sendAdminServiceError(res, cause); }
  });
}

export default createGenerateFlowImageRouter();
