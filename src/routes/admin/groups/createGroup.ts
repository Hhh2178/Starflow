import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { createGroup } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string().trim().min(2).max(64),
    adminUserId: z.number().int().positive(),
    creatorLimit: z.number().int().min(0).max(1000).default(5),
    status: z.enum(["enabled", "disabled"]).default("enabled"),
  }),
  async (req, res) => {
    try {
      const data = await createGroup(getAuthUser(req), req.body);
      return res.send(success(data, "分组创建成功"));
    } catch (cause) {
      return sendManagementError(res, cause);
    }
  },
);
