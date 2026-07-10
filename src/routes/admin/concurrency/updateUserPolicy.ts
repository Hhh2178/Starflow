import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { updateUserPolicy } from "@/services/concurrencyPolicy";
import { sendAdminServiceError } from "@/lib/adminServiceError";

const router = express.Router();
const limit = z.number().int().min(1).max(1000);

export default router.post("/", validateFields({
  userId: z.number().int().positive(),
  total: limit,
  text: limit,
  image: limit,
  video: limit,
}), async (req, res) => {
  try {
    const { userId, ...input } = req.body;
    return res.send(success(await updateUserPolicy(getAuthUser(req), userId, input), "个人并发策略已更新"));
  } catch (cause) {
    return sendAdminServiceError(res, cause);
  }
});
