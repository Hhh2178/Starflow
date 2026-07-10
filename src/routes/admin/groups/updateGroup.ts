import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { updateGroup } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";

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
    try {
      const data = await updateGroup(getAuthUser(req), req.body);
      return res.send(success(data, "分组更新成功"));
    } catch (cause) {
      return sendManagementError(res, cause);
    }
  },
);
