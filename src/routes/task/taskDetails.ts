import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { getAuthUser } from "@/middleware/auth";
import { AccessScopeError, assertResourceAccess } from "@/services/accessScope";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    taskId: z.number(),
  }),
  async (req, res) => {
    const { taskId } = req.body;
    try {
      await assertResourceAccess(getAuthUser(req), "task", taskId);
    } catch (cause) {
      if (cause instanceof AccessScopeError) return res.status(404).send(error("任务不存在或当前账号无权访问"));
      throw cause;
    }
    const data = await u.db("o_tasks").where("id", taskId).select("*").first();
    res.status(200).send(success(data));
  }
);
