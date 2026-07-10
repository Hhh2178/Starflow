import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { hashPassword } from "@/utils/password";
import { canManageUser, SAFE_USER_COLUMNS, toSafeUser } from "@/services/userManagement";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    password: z.string().min(6).max(20),
  }),
  async (req, res) => {
    const actor = getAuthUser(req);
    const id = Number(req.body.id);
    const row = await u.db("o_user").select(SAFE_USER_COLUMNS).where("id", id).first();
    if (!row) return res.status(404).send(error("用户不存在"));
    if (!canManageUser(actor, toSafeUser(row))) return res.status(403).send(error("当前账号不能重置该用户密码"));

    await u.db("o_user").where("id", id).update({
      password: null,
      passwordHash: hashPassword(req.body.password),
      mustChangePassword: true,
      updatedAt: Date.now(),
    });
    res.status(200).send(success(null, "临时密码已重置"));
  },
);
