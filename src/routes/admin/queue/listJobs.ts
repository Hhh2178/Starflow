import express from "express";
import { success, error } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { listGenerationJobs } from "@/services/generationQueue";
import type { GenerationJobStatus, GenerationTaskType } from "@/types/generationQueue";

const router = express.Router();
const statuses = new Set<GenerationJobStatus>(["queued", "running", "recovering", "needs_attention", "succeeded", "failed", "cancelled"]);
const taskTypes = new Set<GenerationTaskType>(["text", "image", "video"]);

export default router.get("/", async (req, res) => {
  const status = req.query.status ? String(req.query.status) as GenerationJobStatus : undefined;
  const taskType = req.query.taskType ? String(req.query.taskType) as GenerationTaskType : undefined;
  if (status && !statuses.has(status)) return res.status(400).send(error("任务状态无效"));
  if (taskType && !taskTypes.has(taskType)) return res.status(400).send(error("任务类型无效"));
  const ownerUserId = req.query.ownerUserId === undefined ? undefined : Number(req.query.ownerUserId);
  if (ownerUserId !== undefined && (!Number.isInteger(ownerUserId) || ownerUserId <= 0)) {
    return res.status(400).send(error("用户 ID 无效"));
  }
  return res.send(success(await listGenerationJobs(getAuthUser(req), { status, taskType, ownerUserId })));
});
