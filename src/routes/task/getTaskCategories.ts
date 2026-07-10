import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { applyProjectScope } from "@/services/accessScope";
const router = express.Router();

export default router.post("/", async (req, res) => {
  const query = u
    .db("o_tasks")
    .leftJoin("o_project", "o_project.id", "o_tasks.projectId")
    .select("o_tasks.taskClass")
    .groupBy("o_tasks.taskClass");
  const list = await applyProjectScope(query, getAuthUser(req));
  const data = list.filter((item: any) => item.taskClass);
  res.status(200).send(success(data));
});
