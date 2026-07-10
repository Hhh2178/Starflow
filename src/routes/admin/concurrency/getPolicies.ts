import express from "express";
import { success, error } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { getScopedEffectivePolicies } from "@/services/concurrencyPolicy";
import { sendAdminServiceError } from "@/lib/adminServiceError";

const router = express.Router();

export default router.get("/", async (req, res) => {
  const groupId = Number(req.query.groupId);
  const userId = Number(req.query.userId);
  if (!Number.isInteger(groupId) || groupId <= 0 || !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).send(error("分组 ID 和用户 ID 必须是正整数"));
  }
  try {
    return res.send(success(await getScopedEffectivePolicies(getAuthUser(req), groupId, userId)));
  } catch (cause) {
    return sendAdminServiceError(res, cause);
  }
});
