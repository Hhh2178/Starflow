import express from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { enqueueVideoJobs } from "@/services/generationWorkflows";

const router = express.Router();
const referenceSchema = z.object({ id: z.number(), sources: z.enum(["assets", "storyboard"]) });

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    trackData: z.array(z.object({
      uploadData: z.array(referenceSchema),
      trackId: z.number(),
      prompt: z.string(),
      duration: z.number(),
    })),
    model: z.string(),
    mode: z.string(),
    resolution: z.string(),
    audio: z.boolean().optional(),
  }),
  async (req, res) => {
    const requestId = String(req.headers["x-request-id"] || uuidv4());
    const items = await enqueueVideoJobs(getAuthUser(req), {
      projectId: req.body.projectId,
      scriptId: req.body.scriptId,
      model: req.body.model,
      mode: req.body.mode,
      resolution: req.body.resolution,
      audio: req.body.audio ?? false,
      tracks: req.body.trackData.map((track: any) => ({
        trackId: track.trackId,
        prompt: track.prompt,
        duration: track.duration,
        references: track.uploadData.map((reference: any) => ({
          kind: reference.sources === "assets" ? "asset" as const : "storyboard" as const,
          id: reference.id,
        })),
      })),
    }, requestId);
    return res.status(200).send(success({ items, total: items.length, message: "已加入视频生成队列" }));
  },
);
