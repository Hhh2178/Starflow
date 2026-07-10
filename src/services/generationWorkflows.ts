import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import { enqueueGeneration, GenerationQueueError } from "@/services/generationQueue";

type WorkflowConnection = Knex | Knex.Transaction;

export interface QueuedWorkflowItem {
  jobId: number;
  targetId: number;
  status: "queued";
}

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
