import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { hashPassword } from "@/utils/password";
import { getAuthUser } from "@/middleware/auth";
import { error } from "@/lib/responseFormat";
import { SAFE_USER_COLUMNS, toSafeUser } from "@/services/userManagement";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string().min(2).max(20),
    password: z.string().min(6).max(20).optional(),
  }),
  async (req, res) => {
    const currentUser = getAuthUser(req);
    const name = req.body.name.trim();
    const password = req.body.password as string | undefined;
    const duplicate = await u.db("o_user").where("name", name).whereNot("id", currentUser.id).first();
    if (duplicate) return res.status(409).send(error("用户名已存在"));

    const updates: Record<string, unknown> = {
      name,
      updatedAt: Date.now(),
    };
    if (password) {
      updates.password = null;
      updates.passwordHash = hashPassword(password);
      updates.mustChangePassword = false;
    }

    await u.db("o_user").where("id", currentUser.id).update(updates);
    const data = await u.db("o_user").select(SAFE_USER_COLUMNS).where("id", currentUser.id).first();
    res.status(200).send(success(toSafeUser(data), "保存设置成功"));
  },
);
