import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { updateGroupPolicy } from "@/services/concurrencyPolicy";
import { sendAdminServiceError } from "@/lib/adminServiceError";

const router = express.Router();
const limit = z.number().int().min(1).max(1000);

export default router.post("/", validateFields({
  groupId: z.number().int().positive(),
  total: limit,
  text: limit,
  image: limit,
  video: limit,
}), async (req, res) => {
  try {
    const { groupId, ...input } = req.body;
    return res.send(success(await updateGroupPolicy(getAuthUser(req), groupId, input), "分组并发策略已更新"));
  } catch (cause) {
    return sendAdminServiceError(res, cause);
  }
});
