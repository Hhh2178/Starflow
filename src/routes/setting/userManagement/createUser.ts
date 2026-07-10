import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { hashPassword } from "@/utils/password";
import { canAssignRole, SAFE_USER_COLUMNS, toSafeUser } from "@/services/userManagement";
import { UserRole } from "@/types/auth";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    name: z.string().min(2).max(20),
    password: z.string().min(6).max(20),
    role: z.enum(["super_admin", "admin", "creator"]),
    status: z.enum(["enabled", "disabled"]).optional(),
  }),
  async (req, res) => {
    const actor = getAuthUser(req);
    const name = req.body.name.trim();
    const role = req.body.role as UserRole;
    const status = req.body.status === "disabled" ? "disabled" : "enabled";
    if (!canAssignRole(actor, role)) return res.status(403).send(error("当前账号不能创建该角色"));

    const duplicate = await u.db("o_user").where("name", name).first();
    if (duplicate) return res.status(409).send(error("用户名已存在"));

    const now = Date.now();
    const [id] = await u.db("o_user").insert({
      name,
      password: null,
      passwordHash: hashPassword(req.body.password),
      role,
      status,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      mustChangePassword: true,
    });
    const data = await u.db("o_user").select(SAFE_USER_COLUMNS).where("id", id).first();
    res.status(200).send(success(toSafeUser(data), "用户创建成功"));
  },
);
