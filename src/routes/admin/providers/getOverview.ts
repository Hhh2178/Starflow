import express from "express";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { getProviderOverview } from "@/services/adminSettings";
import { sendAdminSettingsError } from "@/services/adminSettingsHttp";
import type { AuthUser } from "@/types/auth";

type GetOverview = (actor: AuthUser) => Promise<unknown>;

export function createProviderOverviewRouter(getOverview: GetOverview = getProviderOverview) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    try {
      return res.send(success(await getOverview(getAuthUser(req))));
    } catch (cause) {
      return sendAdminSettingsError(res, cause);
    }
  });
}

export default createProviderOverviewRouter();
