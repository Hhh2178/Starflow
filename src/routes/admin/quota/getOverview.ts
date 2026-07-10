import express from "express";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { getQuotaOverview } from "@/services/quotaManagement";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import type { AuthUser } from "@/types/auth";

type GetQuotaOverview = (actor: AuthUser) => Promise<unknown>;

export function createGetOverviewRouter(getOverview: GetQuotaOverview = getQuotaOverview) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    try {
      return res.send(success(await getOverview(getAuthUser(req))));
    } catch (cause) {
      return sendAdminServiceError(res, cause);
    }
  });
}

export default createGetOverviewRouter();
