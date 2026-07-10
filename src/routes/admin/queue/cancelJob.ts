import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { cancelGenerationJob } from "@/services/generationQueue";
import { sendAdminServiceError } from "@/lib/adminServiceError";

const router = express.Router();

export default router.post("/", validateFields({ id: z.number().int().positive() }), async (req, res) => {
  try {
    return res.send(success(await cancelGenerationJob(getAuthUser(req), req.body.id), "任务取消请求已提交"));
  } catch (cause) {
    return sendAdminServiceError(res, cause);
  }
});
