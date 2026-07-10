import type { RequestHandler } from "express";
import { error } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { getAccessibleProject } from "@/services/accessScope";

export function requireProjectAccess(field: string = "projectId"): RequestHandler {
  return async (req, res, next) => {
    const projectId = Number(req.body?.[field] ?? req.query?.[field] ?? req.params?.[field]);
    const project = Number.isFinite(projectId) ? await getAccessibleProject(getAuthUser(req), projectId) : undefined;
    if (!project) return res.status(404).send(error("项目不存在或当前账号无权访问"));
    res.locals.project = project;
    next();
  };
}
