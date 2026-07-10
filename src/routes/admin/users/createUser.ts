import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { createScopedUser } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";

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
    try {
      const data = await createScopedUser(getAuthUser(req), req.body);
      return res.send(success(data, "用户创建成功"));
    } catch (cause) {
      return sendManagementError(res, cause);
    }
  },
);
