import express from "express";
import { success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { optionalQueryNumber, optionalQueryString, paginationQuery } from "@/lib/adminMonitoringQuery";
import { getAuthUser } from "@/middleware/auth";
import { getUsageOverview, type AdminUsageInput } from "@/services/adminMonitoring";
import type { AuthUser } from "@/types/auth";

type GetUsage = (actor: AuthUser, input: AdminUsageInput) => Promise<unknown>;

export function createUsageOverviewRouter(getOverview: GetUsage = getUsageOverview) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    try {
      return res.send(success(await getOverview(getAuthUser(req), {
        ...paginationQuery(req),
        groupId: optionalQueryNumber(req, "groupId"),
        ownerUserId: optionalQueryNumber(req, "ownerUserId"),
        projectId: optionalQueryNumber(req, "projectId"),
        taskType: optionalQueryString(req, "taskType"),
        providerId: optionalQueryString(req, "providerId"),
        modelId: optionalQueryString(req, "modelId"),
      })));
    } catch (cause) {
      return sendAdminServiceError(res, cause);
    }
  });
}

export default createUsageOverviewRouter();
