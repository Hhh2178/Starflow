import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { enqueueGeneration, GenerationQueueError } from "@/services/generationQueue";

type WorkflowConnection = Knex | Knex.Transaction;

export interface QueuedWorkflowItem {
  jobId: number;
  targetId: number;
  status: "queued";
}

export interface EnqueueAssetImageInput {
  projectId: number;
  assetId: number;
  model: string;
  size: "1K" | "2K" | "4K";
  referenceResourceIds: number[];
}

export interface QueuedAssetImageItem extends QueuedWorkflowItem {
  imageId: number;
}

export interface EnqueueStoryboardImagesInput {
  projectId: number;
  scriptId: number;
  storyboardIds: number[];
  compulsory: boolean;
}

const assetLabels: Record<string, string> = {
  role: "角色",
  scene: "场景",
  tool: "道具",
};

async function resolveConnection(connection?: WorkflowConnection): Promise<WorkflowConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

async function inTransaction<T>(
  connection: WorkflowConnection,
  run: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  if ((connection as Knex.Transaction).isTransaction) return run(connection as Knex.Transaction);
  return (connection as Knex).transaction(run);
}

export async function enqueueNovelEventJobs(
  actor: AuthUser,
  projectId: number,
  novelIds: number[],
  requestId: string,
  connection?: WorkflowConnection,
): Promise<QueuedWorkflowItem[]> {
  const resolvedConnection = await resolveConnection(connection);
  return inTransaction(resolvedConnection, async (trx) => {
    const uniqueNovelIds = [...new Set(novelIds)];
    const chapters = await trx("o_novel").where({ projectId }).whereIn("id", uniqueNovelIds).select("id");
    if (chapters.length === 0) throw new GenerationQueueError(404, "NOVEL_NOT_FOUND", "没有找到可生成的小说章节");
    if (chapters.length !== uniqueNovelIds.length) {
      throw new GenerationQueueError(404, "NOVEL_NOT_FOUND", "部分小说章节不存在或不属于当前项目");
    }

    await trx("o_novel").where({ projectId }).whereIn("id", uniqueNovelIds).update({
      eventState: 0,
      event: null,
      errorReason: null,
    });
    const items: QueuedWorkflowItem[] = [];
    for (const novelId of uniqueNovelIds) {
      const job = await enqueueGeneration(actor, {
        projectId,
        handlerKey: "core.text",
        taskType: "text",
        payload: {
          operation: "novel_events",
          projectId,
          targetId: novelId,
          model: "universalAi",
          prompt: "",
        },
        idempotencyKey: `novel-events:${requestId}:${novelId}`,
      }, trx);
      items.push({ jobId: job.id, targetId: novelId, status: "queued" });
    }
    return items;
  });
}

export async function enqueueAssetImageJob(
  actor: AuthUser,
  input: EnqueueAssetImageInput,
  requestId: string,
  connection?: WorkflowConnection,
): Promise<QueuedAssetImageItem> {
  const resolvedConnection = await resolveConnection(connection);
  return inTransaction(resolvedConnection, async (trx) => {
    const [project, asset] = await Promise.all([
      trx("o_project").where({ id: input.projectId }).select("id", "artStyle").first(),
      trx("o_assets").where({ id: input.assetId, projectId: input.projectId }).first(),
    ]);
    if (!project || !asset) throw new GenerationQueueError(404, "ASSET_NOT_FOUND", "资产不存在或不属于当前项目");
    const referenceIds = [...new Set(input.referenceResourceIds)];
    if (referenceIds.length > 0) {
      const references = await trx("o_image")
        .join("o_assets", "o_assets.id", "o_image.assetsId")
        .whereIn("o_image.id", referenceIds)
        .where("o_assets.projectId", input.projectId)
        .whereNotNull("o_image.filePath")
        .select("o_image.id");
      if (references.length !== referenceIds.length) {
        throw new GenerationQueueError(404, "REFERENCE_NOT_FOUND", "部分参考图片不存在或不属于当前项目");
      }
    }

    const type = String(asset.type || "role");
    const label = assetLabels[type] || "资产";
    const prompt = `生成${label}标准图。画风：${project.artStyle || "未指定"}。名称：${asset.name || "未命名"}。设定：${asset.prompt || ""}`;
    const [imageId] = await trx("o_image").insert({
      type,
      state: "生成中",
      assetsId: input.assetId,
      model: input.model.split(/:(.+)/)[1] || input.model,
      resolution: input.size,
    });
    await trx("o_assets").where({ id: input.assetId }).update({ imageId });
    const job = await enqueueGeneration(actor, {
      projectId: input.projectId,
      handlerKey: "core.image",
      taskType: "image",
      payload: {
        operation: "asset",
        projectId: input.projectId,
        targetId: Number(imageId),
        model: input.model,
        prompt,
        referenceResourceIds: referenceIds,
        size: input.size,
        aspectRatio: "16:9",
      },
      idempotencyKey: `asset-image:${requestId}:${input.assetId}`,
    }, trx);
    return { jobId: job.id, targetId: input.assetId, imageId: Number(imageId), status: "queued" };
  });
}

export async function enqueueStoryboardImageJobs(
  actor: AuthUser,
  input: EnqueueStoryboardImagesInput,
  requestId: string,
  connection?: WorkflowConnection,
): Promise<QueuedWorkflowItem[]> {
  const resolvedConnection = await resolveConnection(connection);
  return inTransaction(resolvedConnection, async (trx) => {
    const storyboardIds = [...new Set(input.storyboardIds)];
    const [project, storyboards] = await Promise.all([
      trx("o_project").where({ id: input.projectId }).select("imageModel", "imageQuality", "videoRatio").first(),
      trx("o_storyboard")
        .where({ projectId: input.projectId, scriptId: input.scriptId })
        .whereIn("id", storyboardIds)
        .select("id", "prompt", "shouldGenerateImage"),
    ]);
    if (!project || storyboards.length !== storyboardIds.length) {
      throw new GenerationQueueError(404, "STORYBOARD_NOT_FOUND", "部分分镜不存在或不属于当前项目");
    }
    if (!project.imageModel || !project.imageQuality) {
      throw new GenerationQueueError(422, "IMAGE_MODEL_REQUIRED", "项目尚未配置图片模型或图片质量");
    }

    const selected = input.compulsory
      ? storyboards
      : storyboards.filter((item: any) => Number(item.shouldGenerateImage) !== 0);
    const skippedIds = storyboards.filter((item: any) => !selected.includes(item)).map((item: any) => Number(item.id));
    if (skippedIds.length > 0) await trx("o_storyboard").whereIn("id", skippedIds).update({ state: "未生成" });

    const relationRows = selected.length === 0
      ? []
      : await trx("o_assets2Storyboard")
        .join("o_assets", "o_assets.id", "o_assets2Storyboard.assetId")
        .whereIn("o_assets2Storyboard.storyboardId", selected.map((item: any) => item.id))
        .whereNotNull("o_assets.imageId")
        .select("o_assets2Storyboard.storyboardId", "o_assets.imageId")
        .orderBy("o_assets2Storyboard.rowid");
    const referencesByStoryboard = new Map<number, number[]>();
    for (const row of relationRows) {
      const storyboardId = Number(row.storyboardId);
      const references = referencesByStoryboard.get(storyboardId) ?? [];
      references.push(Number(row.imageId));
      referencesByStoryboard.set(storyboardId, references);
    }

    const items: QueuedWorkflowItem[] = [];
    for (const storyboard of selected) {
      const targetId = Number(storyboard.id);
      await trx("o_storyboard").where({ id: targetId }).update({ state: "生成中", reason: null });
      const job = await enqueueGeneration(actor, {
        projectId: input.projectId,
        handlerKey: "core.image",
        taskType: "image",
        payload: {
          operation: "storyboard",
          projectId: input.projectId,
          targetId,
          model: String(project.imageModel),
          prompt: String(storyboard.prompt || ""),
          referenceResourceIds: referencesByStoryboard.get(targetId) ?? [],
          size: project.imageQuality,
          aspectRatio: String(project.videoRatio || "16:9"),
        },
        idempotencyKey: `storyboard-image:${requestId}:${targetId}`,
      }, trx);
      items.push({ jobId: job.id, targetId, status: "queued" });
    }
    return items;
  });
}
