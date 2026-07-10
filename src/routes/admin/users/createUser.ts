import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { createScopedUser, ManagementError } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";
import { writeAudit } from "@/services/auditLog";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string().trim().min(2).max(64),
    password: z.string().min(8).max(128),
    role: z.enum(["super_admin", "admin", "creator"]),
    status: z.enum(["enabled", "disabled"]).optional(),
    groupId: z.number().int().positive().optional(),
    groupName: z.string().trim().min(2).max(64).optional(),
    creatorLimit: z.number().int().min(0).max(1000).optional(),
  }),
  async (req, res) => {
    const actor = getAuthUser(req);
    try {
      const data = await createScopedUser(actor, req.body);
      return res.send(success(data, "用户创建成功"));
    } catch (cause) {
      await writeAudit({
        actor,
        groupId: actor.groupId,
        action: "user.create.rejected",
        targetType: "user",
        summary: { role: req.body.role, groupId: req.body.groupId ?? actor.groupId, reasonCode: cause instanceof ManagementError ? cause.code : "UNEXPECTED" },
        result: "failure",
      });
      return sendManagementError(res, cause);
    }
  },
);
