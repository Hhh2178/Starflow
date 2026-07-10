import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { ManagementError, resetScopedPassword } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";
import { writeAudit } from "@/services/auditLog";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    password: z.string().min(8).max(128),
  }),
  async (req, res) => {
    const actor = getAuthUser(req);
    try {
      await resetScopedPassword(actor, Number(req.body.id), req.body.password);
      return res.send(success(null, "临时密码已重置"));
    } catch (cause) {
      await writeAudit({
        actor,
        groupId: actor.groupId,
        action: "user.password_reset.rejected",
        targetType: "user",
        targetId: req.body.id,
        summary: { reasonCode: cause instanceof ManagementError ? cause.code : "UNEXPECTED" },
        result: "failure",
      });
      return sendManagementError(res, cause);
    }
  },
);
