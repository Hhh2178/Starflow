import type { RequestHandler } from "express";
import { error } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { getAccessibleProject, getProjectIdForResource, ResourceKind } from "@/services/accessScope";

export function requireProjectAccess(field: string = "projectId"): RequestHandler {
  return async (req, res, next) => {
    const projectId = Number(req.body?.[field] ?? req.query?.[field] ?? req.params?.[field]);
    const project = Number.isFinite(projectId) ? await getAccessibleProject(getAuthUser(req), projectId) : undefined;
    if (!project) return res.status(404).send(error("项目不存在或当前账号无权访问"));
    res.locals.project = project;
    next();
  };
}

interface ResourceFieldPolicy {
  field: string;
  kind: ResourceKind;
}

const ambiguousResourcePolicies: Record<string, ResourceFieldPolicy[]> = {
  "/api/general/getSingleProject": [{ field: "id", kind: "project" }],
  "/api/general/updateProject": [{ field: "id", kind: "project" }],
  "/api/novel/batchDeleteNovel": [{ field: "ids", kind: "novel" }],
  "/api/novel/delNovel": [{ field: "id", kind: "novel" }],
  "/api/novel/getNovelEventState": [{ field: "ids", kind: "novel" }],
  "/api/novel/updateNovel": [{ field: "id", kind: "novel" }],
  "/api/novel/event/batchDeleteEvent": [{ field: "ids", kind: "event" }],
  "/api/novel/event/deletEvent": [{ field: "id", kind: "event" }],
  "/api/script/delScript": [{ field: "ids", kind: "script" }],
  "/api/script/exportScript": [{ field: "id", kind: "script" }],
  "/api/script/pollScriptAssets": [{ field: "ids", kind: "script" }],
  "/api/script/updateScript": [
    { field: "id", kind: "script" },
    { field: "assets", kind: "asset" },
  ],
  "/api/scriptAgent/updateData": [{ field: "id", kind: "agentWork" }],
  "/api/assets/batchDelete": [{ field: "id", kind: "asset" }],
  "/api/assets/delAssets": [{ field: "id", kind: "asset" }],
  "/api/assets/delImage": [{ field: "id", kind: "image" }],
  "/api/assets/pollingImageAssets": [{ field: "ids", kind: "asset" }],
  "/api/assets/pollingPromptAssets": [{ field: "ids", kind: "asset" }],
  "/api/assets/updateAssets": [{ field: "id", kind: "asset" }],
  "/api/assetsGenerate/cancelGenerate": [{ field: "id", kind: "image" }],
  "/api/cornerScape/pollingAudio": [{ field: "ids", kind: "asset" }],
  "/api/production/assets/deleteAssetsDireve": [{ field: "id", kind: "asset" }],
  "/api/production/assets/pollingImage": [{ field: "ids", kind: "asset" }],
  "/api/production/assets/updateAssetsUrl": [{ field: "id", kind: "asset" }],
  "/api/production/editImage/getImageFlow": [{ field: "id", kind: "imageFlow" }],
  "/api/production/editImage/updateImageFlow": [{ field: "flowId", kind: "imageFlow" }],
  "/api/production/storyboard/batchDelete": [{ field: "ids", kind: "storyboard" }],
  "/api/production/storyboard/downPreviewImage": [{ field: "ids", kind: "storyboard" }],
  "/api/production/storyboard/editStoryboardInfo": [{ field: "id", kind: "storyboard" }],
  "/api/production/storyboard/pollingImage": [{ field: "ids", kind: "storyboard" }],
  "/api/production/storyboard/previewImage": [{ field: "id", kind: "storyboard" }],
  "/api/production/storyboard/removeFrame": [{ field: "id", kind: "storyboard" }],
  "/api/production/storyboard/updateStoryboardUrl": [{ field: "id", kind: "storyboard" }],
  "/api/production/workbench/deleteTrack": [{ field: "id", kind: "track" }],
  "/api/production/workbench/delVideo": [{ field: "id", kind: "video" }],
  "/api/production/workbench/updateVideoDuration": [{ field: "id", kind: "track" }],
  "/api/production/workbench/updateVideoPrompt": [{ field: "id", kind: "track" }],
};

const namedResourceFields: ResourceFieldPolicy[] = [
  { field: "novelId", kind: "novel" },
  { field: "novelIds", kind: "novel" },
  { field: "scriptId", kind: "script" },
  { field: "scriptIds", kind: "script" },
  { field: "episodesId", kind: "script" },
  { field: "assetId", kind: "asset" },
  { field: "assetIds", kind: "asset" },
  { field: "assetsId", kind: "asset" },
  { field: "assetsIds", kind: "asset" },
  { field: "storyboardId", kind: "storyboard" },
  { field: "storyboardIds", kind: "storyboard" },
  { field: "videoId", kind: "video" },
  { field: "videoIds", kind: "video" },
  { field: "trackId", kind: "track" },
  { field: "trackIds", kind: "track" },
  { field: "taskId", kind: "task" },
  { field: "taskIds", kind: "task" },
  { field: "flowId", kind: "imageFlow" },
];

const protectedRoutePrefix = /^\/api\/(agents|novel|script|scriptAgent|assets|assetsGenerate|cornerScape|production|general|project|task)(\/|$)/;
const superAdminOnlyGlobalMutations = new Set([
  "/api/project/addDirectorManual",
  "/api/project/addVisualManual",
  "/api/project/deleteDirectorManual",
  "/api/project/deleteVisualManual",
  "/api/project/editDirectorlManual",
  "/api/project/editVisualManual",
]);

function nestedResourceReferences(path: string, body: any): Array<{ kind: ResourceKind; id: number }> {
  const references: Array<{ kind: ResourceKind; id: number }> = [];
  const add = (kind: ResourceKind, values: unknown[]) => {
    for (const value of values) references.push({ kind, id: Number(value) });
  };
  const addMixed = (items: any[]) => {
    for (const item of items ?? []) {
      if (item?.sources === "storyboard") add("storyboard", [item.id]);
      if (item?.sources === "assets") add("asset", [item.id]);
    }
  };

  if (path === "/api/assetsGenerate/batchGenerateImageAssets") add("asset", (body.items ?? []).map((item: any) => item.id));
  if (path === "/api/assetsGenerate/batchPolishAssetsPrompt") add("asset", (body.items ?? []).map((item: any) => item.assetsId));
  if (path === "/api/production/storyboard/batchAddStoryboardInfo") {
    add("asset", (body.data ?? []).flatMap((item: any) => item.associateAssetsIds ?? []));
  }
  if (path === "/api/production/workbench/batchGeneratePrompt") {
    add("track", (body.trackData ?? []).map((track: any) => track.trackId));
    for (const track of body.trackData ?? []) addMixed(track.info ?? []);
  }
  if (path === "/api/production/workbench/batchGenerateVideo") {
    add("track", (body.trackData ?? []).map((track: any) => track.trackId));
    for (const track of body.trackData ?? []) addMixed(track.uploadData ?? []);
  }
  if (path === "/api/production/workbench/generateVideo") addMixed(body.uploadData ?? []);
  if (path === "/api/production/workbench/generateVideoPrompt") addMixed(body.info ?? []);
  if (path === "/api/production/workbench/getFileUrl") addMixed(body.items ?? []);
  return references;
}

export const requireScopedProductionAccess: RequestHandler = async (req, res, next) => {
  if (!protectedRoutePrefix.test(req.path)) return next();
  const actor = getAuthUser(req);
  if (superAdminOnlyGlobalMutations.has(req.path) && actor.role !== "super_admin") {
    return res.status(403).send(error("仅超级管理员可修改全局手册"));
  }
  const body = req.body ?? {};
  const resolvedProjectIds: number[] = [];

  if (body.projectId !== undefined && body.projectId !== null) {
    const projectId = Number(body.projectId);
    if (!Number.isFinite(projectId) || !(await getAccessibleProject(actor, projectId))) {
      return res.status(404).send(error("项目不存在或当前账号无权访问"));
    }
    resolvedProjectIds.push(projectId);
  }

  const policies = [...namedResourceFields, ...(ambiguousResourcePolicies[req.path] ?? [])];
  const seen = new Set<string>();
  for (const policy of policies) {
    const key = `${policy.kind}:${policy.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rawValue = body[policy.field];
    if (rawValue === undefined || rawValue === null) continue;
    const ids = (Array.isArray(rawValue) ? rawValue : [rawValue]).map(Number);
    for (const id of ids) {
      if (!Number.isFinite(id)) return res.status(404).send(error("资源不存在或当前账号无权访问"));
      const projectId = await getProjectIdForResource(policy.kind, id);
      if (projectId === null || !(await getAccessibleProject(actor, projectId))) {
        return res.status(404).send(error("资源不存在或当前账号无权访问"));
      }
      resolvedProjectIds.push(projectId);
    }
  }

  for (const reference of nestedResourceReferences(req.path, body)) {
    if (!Number.isFinite(reference.id)) return res.status(404).send(error("资源不存在或当前账号无权访问"));
    const projectId = await getProjectIdForResource(reference.kind, reference.id);
    if (projectId === null || !(await getAccessibleProject(actor, projectId))) {
      return res.status(404).send(error("资源不存在或当前账号无权访问"));
    }
    resolvedProjectIds.push(projectId);
  }

  if (new Set(resolvedProjectIds).size > 1) {
    return res.status(404).send(error("请求中的资源不属于同一项目"));
  }
  next();
};
