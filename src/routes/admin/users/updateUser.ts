import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { ManagementError, updateScopedUser } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";
import { writeAudit } from "@/services/auditLog";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    name: z.string().trim().min(2).max(64).optional(),
    role: z.enum(["super_admin", "admin", "creator"]).optional(),
    status: z.enum(["enabled", "disabled"]).optional(),
    groupId: z.number().int().positive().optional(),
  }),
  async (req, res) => {
    const actor = getAuthUser(req);
    try {
      const data = await updateScopedUser(actor, req.body);
      return res.send(success(data, "用户更新成功"));
    } catch (cause) {
      await writeAudit({
        actor,
        groupId: actor.groupId,
        action: "user.update.rejected",
        targetType: "user",
        targetId: req.body.id,
        summary: { changedFields: Object.keys(req.body).filter((key) => key !== "id").sort().join(","), reasonCode: cause instanceof ManagementError ? cause.code : "UNEXPECTED" },
        result: "failure",
      });
      return sendManagementError(res, cause);
    }
  },
);
