import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { sendAdminServiceError } from "@/lib/adminServiceError";
import { getAuthUser } from "@/middleware/auth";
import { listAudit, type AuditListInput } from "@/services/auditLog";
import type { AuthUser } from "@/types/auth";

const auditQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  groupId: z.coerce.number().int().positive().optional(),
});

type ListAudit = (actor: AuthUser, input: AuditListInput) => Promise<unknown>;

export function createListAuditRouter(list: ListAudit = listAudit) {
  const router = express.Router();
  return router.get("/", async (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).send(error("审计日志查询参数错误", { code: "INVALID_PARAMETERS" }));
    }
    try {
      return res.send(success(await list(getAuthUser(req), parsed.data)));
    } catch (cause) {
      return sendAdminServiceError(res, cause);
    }
  });
}

export default createListAuditRouter();
