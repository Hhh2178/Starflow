import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { reprioritizeGenerationJob } from "@/services/generationQueue";
import { sendAdminServiceError } from "@/lib/adminServiceError";

const router = express.Router();

export default router.post("/", validateFields({
  id: z.number().int().positive(),
  priority: z.number().int().min(-1000).max(1000),
  reason: z.string().trim().min(2).max(200),
}), async (req, res) => {
  try {
    return res.send(success(
      await reprioritizeGenerationJob(getAuthUser(req), req.body.id, req.body.priority, req.body.reason),
      "任务优先级已更新",
    ));
  } catch (cause) {
    return sendAdminServiceError(res, cause);
  }
});
