import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAuthUser } from "@/middleware/auth";
import { db } from "@/utils/db";
import { writeAudit } from "@/services/auditLog";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    projectType: z.string(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    directorManual: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
    groupId: z.number().int().positive().optional(),
  }),
  async (req, res) => {
    const { projectType, name, intro, type, directorManual, artStyle, videoRatio, imageModel, videoModel, imageQuality, mode } = req.body;
    const actor = getAuthUser(req);
    let groupId = actor.groupId;
    if (actor.role === "super_admin") {
      groupId = req.body.groupId == null ? null : Number(req.body.groupId);
      const group = groupId == null ? null : await u.db("o_group").where("id", groupId).first();
      if (!group) return res.status(400).send({ message: "超级管理员创建项目时必须选择有效分组" });
    }

    const id = await db.transaction(async (trx) => {
      const maxProject = await trx("o_project").max({ maxId: "id" }).first();
      const projectId = Math.max(Date.now(), Number(maxProject?.maxId ?? 0) + 1);
      await trx("o_project").insert({
        id: projectId,
        projectType,
        name,
        intro,
        type,
        artStyle,
        videoRatio,
        directorManual,
        userId: actor.id,
        ownerUserId: actor.id,
        groupId,
        imageModel,
        videoModel,
        createTime: Date.now(),
        imageQuality,
        mode,
      });
      await writeAudit({
        actor,
        groupId,
        action: "project.create",
        targetType: "project",
        targetId: projectId,
        summary: { name, projectId, ownerUserId: actor.id, groupId },
        result: "success",
      }, trx);
      return projectId;
    });

    res.status(200).send(success({ id, message: "新增项目成功" }));
  },
);
