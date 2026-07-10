import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { ManagementError, updateGroup } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";
import { writeAudit } from "@/services/auditLog";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    name: z.string().trim().min(2).max(64).optional(),
    adminUserId: z.number().int().positive().optional(),
    creatorLimit: z.number().int().min(0).max(1000).optional(),
    status: z.enum(["enabled", "disabled"]).optional(),
  }),
  async (req, res) => {
    const actor = getAuthUser(req);
    try {
      const data = await updateGroup(actor, req.body);
      return res.send(success(data, "分组更新成功"));
    } catch (cause) {
      await writeAudit({
        actor,
        groupId: req.body.id,
        action: "group.update.rejected",
        targetType: "group",
        targetId: req.body.id,
        summary: { changedFields: Object.keys(req.body).filter((key) => key !== "id").sort().join(","), reasonCode: cause instanceof ManagementError ? cause.code : "UNEXPECTED" },
        result: "failure",
      });
      return sendManagementError(res, cause);
    }
  },
);
