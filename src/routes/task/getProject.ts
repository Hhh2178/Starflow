import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { applyProjectScope } from "@/services/accessScope";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const list = await applyProjectScope(u.db("o_project").select("id", "name").groupBy("id", "name"), getAuthUser(req));
  const data = list.filter((item: any) => item.name);
  res.status(200).send(success(data));
});
