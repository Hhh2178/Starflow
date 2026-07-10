import express from "express";
import { error, success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { getAuthUser } from "@/middleware/auth";
import { getGenerationJob } from "@/services/generationQueue";

const router = express.Router();

export default router.get("/", async (req, res) => {
  const jobId = Number(req.query.id);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return res.status(400).send(error("任务 ID 无效"));
  }
  try {
    return res.send(success(await getGenerationJob(getAuthUser(req), jobId)));
  } catch (cause) {
    return sendAdminServiceError(res, cause);
  }
});
