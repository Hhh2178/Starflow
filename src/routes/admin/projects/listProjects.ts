import express from "express";
import { success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { optionalQueryNumber, optionalQueryString, paginationQuery } from "@/lib/adminMonitoringQuery";
import { getAuthUser } from "@/middleware/auth";
import { listAdminProjects, type AdminListInput } from "@/services/adminMonitoring";
import type { AuthUser } from "@/types/auth";

type ListProjects = (actor: AuthUser, input: AdminListInput) => Promise<unknown>;

export function createListProjectsRouter(listProjects: ListProjects = listAdminProjects) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    try {
      return res.send(success(await listProjects(getAuthUser(req), {
        ...paginationQuery(req),
        groupId: optionalQueryNumber(req, "groupId"),
        ownerUserId: optionalQueryNumber(req, "ownerUserId"),
        search: optionalQueryString(req, "search"),
      })));
    } catch (cause) {
      return sendAdminServiceError(res, cause);
    }
  });
}

export default createListProjectsRouter();
