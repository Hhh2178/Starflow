import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { enqueueNovelEventJobs } from "@/services/generationWorkflows";

const router = express.Router();

// 清洗小说原文，生成事件列表
export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    novelIds: z.array(z.number()),
    concurrentCount: z.number().min(1).optional(),
  }),
  async (req, res) => {
    const { projectId, novelIds } = req.body;
    const requestId = String(req.headers["x-request-id"] || uuidv4());
    const items = await enqueueNovelEventJobs(getAuthUser(req), projectId, novelIds, requestId);
    return res.status(200).send(success({ items, message: "已加入生成队列" }));
  },
);
