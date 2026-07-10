import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { canAssignRole, canManageUser, SAFE_USER_COLUMNS, toSafeUser } from "@/services/userManagement";
import { UserRole, UserStatus } from "@/types/auth";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    name: z.string().min(2).max(20),
    role: z.enum(["super_admin", "admin", "creator"]),
    status: z.enum(["enabled", "disabled"]),
  }),
  async (req, res) => {
    const actor = getAuthUser(req);
    const id = Number(req.body.id);
    const name = req.body.name.trim();
    const role = req.body.role as UserRole;
    const status = req.body.status as UserStatus;
    const row = await u.db("o_user").select(SAFE_USER_COLUMNS).where("id", id).first();
    if (!row) return res.status(404).send(error("用户不存在"));

    const target = toSafeUser(row);
    if (!canManageUser(actor, target) || !canAssignRole(actor, role)) {
      return res.status(403).send(error("当前账号不能修改该用户"));
    }
    if (actor.id === id && (role !== actor.role || status === "disabled")) {
      return res.status(400).send(error("不能停用或修改自己的角色"));
    }

    const duplicate = await u.db("o_user").where("name", name).whereNot("id", id).first();
    if (duplicate) return res.status(409).send(error("用户名已存在"));

    if (target.role === "super_admin" && (role !== "super_admin" || status === "disabled")) {
      const countRow = await u
        .db("o_user")
        .where("role", "super_admin")
        .where("status", "enabled")
        .whereNot("id", id)
        .count({ count: "id" })
        .first();
      if (Number(countRow?.count || 0) === 0) return res.status(400).send(error("必须保留至少一个启用的超级管理员"));
    }

    await u.db("o_user").where("id", id).update({ name, role, status, updatedAt: Date.now() });
    const updated = await u.db("o_user").select(SAFE_USER_COLUMNS).where("id", id).first();
    res.status(200).send(success(toSafeUser(updated), "用户更新成功"));
  },
);
