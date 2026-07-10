import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectAccess } from "@/middleware/projectAccess";
import { getAuthUser } from "@/middleware/auth";
import { writeAudit } from "@/services/auditLog";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    directorManual: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    projectType: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
  }),
  requireProjectAccess("id"),
  async (req, res) => {
    const { id, name, intro, type, artStyle, videoRatio, directorManual, imageModel, videoModel, imageQuality, projectType, mode } = req.body;

    await u.db("o_project").where("id", id).update({
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      directorManual,
      imageModel,
      videoModel,
      imageQuality,
      projectType,
      mode,
    });

    const actor = getAuthUser(req);
    await writeAudit({
      actor,
      groupId: res.locals.project.groupId,
      action: "project.update",
      targetType: "project",
      targetId: id,
      summary: { projectId: id, changedFields: "artStyle,directorManual,imageModel,imageQuality,intro,mode,name,projectType,type,videoModel,videoRatio" },
      result: "success",
    });

    res.status(200).send(success({ message: "编辑项目成功" }));
  },
);
