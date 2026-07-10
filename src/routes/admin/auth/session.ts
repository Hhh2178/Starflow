import express from "express";
import { error, success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import u from "@/utils";

const router = express.Router();

export default router.get("/", async (req, res) => {
  const user = getAuthUser(req);
  if (user.role === "creator") {
    return res.status(403).send(error("当前账号不能进入管理后台"));
  }

  const group = user.groupId == null ? null : await u.db("o_group").where("id", user.groupId).select("name").first();
  return res.send(success({ ...user, groupName: group?.name ?? null }));
});
