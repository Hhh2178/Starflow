import express from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { addNovelAndEnqueueEventJobs, type AddNovelInput, type QueuedWorkflowItem } from "@/services/generationWorkflows";
import type { AuthUser } from "@/types/auth";

type AddNovel = (actor: AuthUser, input: AddNovelInput, requestId: string) => Promise<{ novelIds: number[]; items: QueuedWorkflowItem[] }>;

export function createAddNovelRouter(addNovel: AddNovel = addNovelAndEnqueueEventJobs) {
  const router = express.Router();
  return router.post("/", validateFields({ projectId: z.number().int().positive(), data: z.array(z.object({ index: z.number(), reel: z.string(), chapter: z.string(), chapterData: z.string() })).min(1) }), async (req, res) => {
    try {
      const result = await addNovel(getAuthUser(req), req.body, String(req.headers["x-request-id"] || uuidv4()));
      return res.status(200).send(success({ ...result, total: result.items.length, message: "原文已导入，事件提取已加入队列" }));
    } catch (cause) { return sendAdminServiceError(res, cause); }
  });
}

export default createAddNovelRouter();
