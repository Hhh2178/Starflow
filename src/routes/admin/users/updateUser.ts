import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { updateScopedUser } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";

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
    try {
      const data = await updateScopedUser(getAuthUser(req), req.body);
      return res.send(success(data, "用户更新成功"));
    } catch (cause) {
      return sendManagementError(res, cause);
    }
  },
);
