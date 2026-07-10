import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { enqueueStoryboardImageJobs } from "@/services/generationWorkflows";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    storyboardIds: z.array(z.number()),
    projectId: z.number(),
    scriptId: z.number(),
    concurrentCount: z.number().min(1).optional(),
    compulsory: z.boolean().optional(),
  }),
  async (req, res) => {
    if (req.body.storyboardIds.length === 0) return res.status(400).send(error("分镜 ID 不能为空"));
    const requestId = String(req.headers["x-request-id"] || uuidv4());
    const items = await enqueueStoryboardImageJobs(
      getAuthUser(req),
      {
        projectId: req.body.projectId,
        scriptId: req.body.scriptId,
        storyboardIds: req.body.storyboardIds,
        compulsory: req.body.compulsory ?? false,
      },
      requestId,
    );
    return res.status(200).send(success({ items, total: items.length, message: "已加入分镜图片生成队列" }));
  },
);
