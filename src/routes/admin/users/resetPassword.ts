import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { validateFields } from "@/middleware/middleware";
import { resetScopedPassword } from "@/services/groupManagement";
import { sendManagementError } from "@/lib/managementError";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    password: z.string().min(8).max(128),
  }),
  async (req, res) => {
    try {
      await resetScopedPassword(getAuthUser(req), Number(req.body.id), req.body.password);
      return res.send(success(null, "临时密码已重置"));
    } catch (cause) {
      return sendManagementError(res, cause);
    }
  },
);
