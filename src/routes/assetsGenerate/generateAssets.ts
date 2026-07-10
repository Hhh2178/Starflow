import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { enqueueAssetImageJob } from "@/services/generationWorkflows";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    model: z.string(),
    resolution: z.enum(["1K", "2K", "4K"]),
    id: z.number(),
    type: z.enum(["role", "scene", "tool", "storyboard"]),
    name: z.string(),
    prompt: z.string(),
    base64: z.string().optional().nullable(),
    referenceResourceIds: z.array(z.number().int().positive()).optional(),
  }),
  async (req, res) => {
    if (req.body.base64) {
      return res.status(422).send(error("参考图需要先上传为项目资源，不能直接提交 Base64"));
    }
    const requestId = String(req.headers["x-request-id"] || uuidv4());
    const item = await enqueueAssetImageJob(
      getAuthUser(req),
      {
        projectId: req.body.projectId,
        assetId: req.body.id,
        model: req.body.model,
        size: req.body.resolution,
        referenceResourceIds: req.body.referenceResourceIds ?? [],
      },
      requestId,
    );
    return res.status(200).send(success({ ...item, message: "已加入图片生成队列" }));
  },
);
