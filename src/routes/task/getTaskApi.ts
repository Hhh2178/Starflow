import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { getAuthUser } from "@/middleware/auth";
import { applyProjectScope } from "@/services/accessScope";
const router = express.Router();
export default router.post(
  "/",
  validateFields({
    state: z.string().optional().nullable(),
    taskClass: z.string().optional().nullable(),
    projectId: z.number().optional().nullable(),
    page: z.number(),
    limit: z.number(),
  }),
  async (req, res) => {
    const { taskClass, state, projectId, page = 1, limit = 10 }: any = req.body;
    const offset = (page - 1) * limit;
    const dataQuery = u
      .db("o_tasks")
      .leftJoin("o_project", "o_project.id", "o_tasks.projectId")
      .andWhere((qb) => {
        if (taskClass) {
          qb.andWhere("o_tasks.taskClass", taskClass);
        }
        if (state) {
          qb.andWhere("o_tasks.state", state);
        }
        if (projectId) {
          qb.andWhere("o_tasks.projectId", projectId);
        }
      })
      .select(
        "o_tasks.*",
        "o_project.name",
        "o_project.projectType",
        "o_project.imageModel",
        "o_project.videoModel",
        "o_project.imageQuality",
        "o_project.mode",
      )
      .offset(offset)
      .limit(limit)
      .orderBy("o_tasks.id", "desc");
    const data = await applyProjectScope(dataQuery, getAuthUser(req));
    const totalBuilder = u
      .db("o_tasks")
      .leftJoin("o_project", "o_project.id", "o_tasks.projectId")
      .andWhere((qb) => {
        if (taskClass) {
          qb.andWhere("o_tasks.taskClass", taskClass);
        }
        if (projectId) {
          qb.andWhere("o_tasks.projectId", projectId);
        }
        if (state) {
          qb.andWhere("o_tasks.state", state);
        }
      })
      .count("o_tasks.id as total");
    const totalQuery = (await applyProjectScope(totalBuilder, getAuthUser(req)).first()) as any;
    res.status(200).send(success({ data, total: totalQuery?.total }));
  },
);
