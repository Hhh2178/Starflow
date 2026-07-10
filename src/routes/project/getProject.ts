import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { applyProjectScope } from "@/services/accessScope";
const router = express.Router();

// 获取项目
export default router.post("/", async (req, res) => {
  const data = await applyProjectScope(u.db("o_project").select("*"), getAuthUser(req));
  res.status(200).send(success(data));
});
