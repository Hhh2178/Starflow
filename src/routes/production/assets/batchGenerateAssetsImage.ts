import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { enqueueAssetImageJobs, type EnqueueAssetImagesInput, type QueuedAssetImageItem } from "@/services/generationWorkflows";
import type { AuthUser } from "@/types/auth";

type EnqueueAssets = (actor: AuthUser, input: EnqueueAssetImagesInput, requestId: string) => Promise<QueuedAssetImageItem[]>;

export function createBatchGenerateAssetsImageRouter(enqueue: EnqueueAssets = enqueueAssetImageJobs) {
  const router = express.Router();
  return router.post("/", validateFields({ assetIds: z.array(z.number().int().positive()).min(1), projectId: z.number().int().positive(), scriptId: z.number().int().positive(), concurrentCount: z.number().min(1).optional() }), async (req, res) => {
    try {
      const items = await enqueue(getAuthUser(req), { projectId: req.body.projectId, assetIds: req.body.assetIds }, String(req.headers["x-request-id"] || uuidv4()));
      return res.status(200).send(success({ items, total: items.length, message: "已加入资产图片生成队列" }));
    } catch (cause) { return sendAdminServiceError(res, cause); }
  });
}

export default createBatchGenerateAssetsImageRouter();
