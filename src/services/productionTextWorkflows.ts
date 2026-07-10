import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { enqueueGeneration, GenerationQueueError } from "@/services/generationQueue";
import type { QueuedWorkflowItem } from "@/services/generationWorkflows";

type WorkflowConnection = Knex | Knex.Transaction;

export interface StylePromptQueueInput { projectId: number; images: string[] }
export interface AssetPromptQueueInput { projectId: number; assetIds: number[]; otherTextPrompt: string }
export interface AssetAudioQueueInput { projectId: number; assetIds: number[] }
export interface ScriptAssetsQueueInput { projectId: number; scriptIds: number[] }
export interface AiRegexQueueInput { projectId: number; content: string }

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

function uniquePositiveIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
}

function queuedItem(job: { id: number; status: QueuedWorkflowItem["status"] }, targetId: number): QueuedWorkflowItem {
  return { jobId: job.id, targetId, status: job.status };
}

async function assertProjectRows(
  trx: Knex.Transaction,
  table: "o_assets" | "o_script",
  projectId: number,
  ids: number[],
  code: string,
  message: string,
) {
  const rows = await trx(table).where({ projectId }).whereIn("id", ids).select("id");
  if (rows.length !== ids.length) throw new GenerationQueueError(404, code, message);
}

export async function enqueueStylePromptJobs(
  actor: AuthUser,
  input: StylePromptQueueInput,
  requestId: string,
  connection?: WorkflowConnection,
): Promise<QueuedWorkflowItem[]> {
  const images = [...new Set(input.images)];
  if (images.length === 0 || images.some((image) => !image.startsWith("/oss/") || image.includes("..") || image.startsWith("/oss//"))) {
    throw new GenerationQueueError(422, "STYLE_IMAGE_INVALID", "画风分析只能使用已上传的本地图片");
  }
  const resolved = await resolveConnection(connection);
  const job = await enqueueGeneration(actor, {
    projectId: input.projectId,
    handlerKey: "core.text",
    taskType: "text",
    payload: {
      operation: "style_prompt",
      projectId: input.projectId,
      targetId: input.projectId,
      model: "universalAi",
      images,
    },
    idempotencyKey: `style-prompt:${requestId}:${input.projectId}`,
  }, resolved);
  return [queuedItem(job, input.projectId)];
}

export async function enqueueAssetPromptJobs(
  actor: AuthUser,
  input: AssetPromptQueueInput,
  requestId: string,
  connection?: WorkflowConnection,
): Promise<QueuedWorkflowItem[]> {
  const assetIds = uniquePositiveIds(input.assetIds);
  const resolved = await resolveConnection(connection);
  return inTransaction(resolved, async (trx) => {
    await assertProjectRows(trx, "o_assets", input.projectId, assetIds, "ASSET_NOT_FOUND", "部分资产不存在或不属于当前项目");
    await trx("o_assets").where({ projectId: input.projectId }).whereIn("id", assetIds).update({ promptState: "生成中", promptErrorReason: null });
    const items: QueuedWorkflowItem[] = [];
    for (const assetId of assetIds) {
      const job = await enqueueGeneration(actor, {
        projectId: input.projectId,
        sourceTaskId: assetId,
        handlerKey: "core.text",
        taskType: "text",
        payload: {
          operation: "asset_prompt",
          projectId: input.projectId,
          targetId: assetId,
          model: "universalAi",
          otherTextPrompt: input.otherTextPrompt,
        },
        idempotencyKey: `asset-prompt:${requestId}:${assetId}`,
      }, trx);
      items.push(queuedItem(job, assetId));
    }
    return items;
  });
}

export async function enqueueAssetAudioJobs(
  actor: AuthUser,
  input: AssetAudioQueueInput,
  requestId: string,
  connection?: WorkflowConnection,
): Promise<QueuedWorkflowItem[]> {
  const assetIds = uniquePositiveIds(input.assetIds);
  const resolved = await resolveConnection(connection);
  return inTransaction(resolved, async (trx) => {
    await assertProjectRows(trx, "o_assets", input.projectId, assetIds, "ASSET_NOT_FOUND", "部分资产不存在或不属于当前项目");
    const audio = await trx("o_assets").where({ projectId: input.projectId, type: "audio" }).whereNull("assetsId").first();
    if (!audio) throw new GenerationQueueError(422, "AUDIO_NOT_CONFIGURED", "暂无设置音频，请先前往资产中心上传音频");
    await trx("o_assets").where({ projectId: input.projectId }).whereIn("id", assetIds).update({ audioBindState: "生成中" });
    const items: QueuedWorkflowItem[] = [];
    for (const assetId of assetIds) {
      const job = await enqueueGeneration(actor, {
        projectId: input.projectId,
        sourceTaskId: assetId,
        handlerKey: "core.text",
        taskType: "text",
        payload: {
          operation: "asset_audio",
          projectId: input.projectId,
          targetId: assetId,
          model: "universalAi",
        },
        idempotencyKey: `asset-audio:${requestId}:${assetId}`,
      }, trx);
      items.push(queuedItem(job, assetId));
    }
    return items;
  });
}

export async function enqueueScriptAssetJobs(
  actor: AuthUser,
  input: ScriptAssetsQueueInput,
  requestId: string,
  connection?: WorkflowConnection,
): Promise<QueuedWorkflowItem[]> {
  const scriptIds = uniquePositiveIds(input.scriptIds);
  const resolved = await resolveConnection(connection);
  return inTransaction(resolved, async (trx) => {
    await assertProjectRows(trx, "o_script", input.projectId, scriptIds, "SCRIPT_NOT_FOUND", "部分剧本不存在或不属于当前项目");
    await trx("o_script").where({ projectId: input.projectId }).whereIn("id", scriptIds).update({ extractState: 0, errorReason: null });
    const items: QueuedWorkflowItem[] = [];
    for (const scriptId of scriptIds) {
      const job = await enqueueGeneration(actor, {
        projectId: input.projectId,
        sourceTaskId: scriptId,
        handlerKey: "core.text",
        taskType: "text",
        payload: {
          operation: "script_assets",
          projectId: input.projectId,
          targetId: scriptId,
          model: "universalAi",
        },
        idempotencyKey: `script-assets:${requestId}:${scriptId}`,
      }, trx);
      items.push(queuedItem(job, scriptId));
    }
    return items;
  });
}

export async function enqueueAiRegexJobs(
  actor: AuthUser,
  input: AiRegexQueueInput,
  requestId: string,
  connection?: WorkflowConnection,
): Promise<QueuedWorkflowItem[]> {
  const resolved = await resolveConnection(connection);
  const job = await enqueueGeneration(actor, {
    projectId: input.projectId,
    handlerKey: "core.text",
    taskType: "text",
    payload: {
      operation: "ai_regex",
      projectId: input.projectId,
      targetId: input.projectId,
      model: "universalAi",
      content: input.content.slice(0, 2_000),
    },
    idempotencyKey: `ai-regex:${requestId}:${input.projectId}`,
  }, resolved);
  return [queuedItem(job, input.projectId)];
}
