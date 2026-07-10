import express from "express";
import { success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { optionalQueryNumber, optionalQueryString, paginationQuery } from "@/lib/adminMonitoringQuery";
import { getAuthUser } from "@/middleware/auth";
import { listAdminTasks, type AdminTaskListInput } from "@/services/adminMonitoring";
import type { AuthUser } from "@/types/auth";

type ListTasks = (actor: AuthUser, input: AdminTaskListInput) => Promise<unknown>;

export function createListTasksRouter(listTasks: ListTasks = listAdminTasks) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    try {
      return res.send(success(await listTasks(getAuthUser(req), {
        ...paginationQuery(req),
        groupId: optionalQueryNumber(req, "groupId"),
        ownerUserId: optionalQueryNumber(req, "ownerUserId"),
        projectId: optionalQueryNumber(req, "projectId"),
        search: optionalQueryString(req, "search"),
        state: optionalQueryString(req, "state"),
        taskClass: optionalQueryString(req, "taskClass"),
      })));
    } catch (cause) {
      return sendAdminServiceError(res, cause);
    }
  });
}

export default createListTasksRouter();
