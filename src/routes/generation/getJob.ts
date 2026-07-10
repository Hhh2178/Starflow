import express from "express";
import { error, success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { getAuthUser } from "@/middleware/auth";
import { getGenerationJob, type GenerationJobDetail } from "@/services/generationQueue";
import type { AuthUser } from "@/types/auth";

type GetGenerationJob = (actor: AuthUser, jobId: number) => Promise<GenerationJobDetail>;

export function createGetJobRouter(getJob: GetGenerationJob = getGenerationJob) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    const jobId = Number(req.query.id);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).send(error("任务 ID 无效"));
    }
    try {
      return res.send(success(await getJob(getAuthUser(req), jobId)));
    } catch (cause) {
      return sendAdminServiceError(res, cause);
    }
  });
}

export default createGetJobRouter();
