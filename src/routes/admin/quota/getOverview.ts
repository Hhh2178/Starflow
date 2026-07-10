import express from "express";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { getQuotaOverview } from "@/services/quotaManagement";
import { sendAdminServiceError } from "@/lib/adminServiceError";

const router = express.Router();

export default router.get("/", async (req, res) => {
  try {
    return res.send(success(await getQuotaOverview(getAuthUser(req))));
  } catch (cause) {
    return sendAdminServiceError(res, cause);
  }
});
