import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import { migrateGenerationQueue } from "@/lib/fixDB";
import { createGenerationJobRegistry } from "@/jobs/registry";
import { cancelGenerationJob, enqueueGeneration } from "@/services/generationQueue";
import { claimNextJob, executeClaimedJob } from "@/services/generationScheduler";
import type { AuthUser } from "@/types/auth";
import type { GenerationJobHandler } from "@/types/generationQueue";

async function main() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, false);
    const now = Date.now();
    const actor: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };
    await db("o_group").insert({ id: 101, name: "A组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now });
    await db("o_user").insert({ ...actor, status: "enabled", createdAt: now, updatedAt: now });
    await db("o_project").insert({ id: 1001, name: "项目一", ownerUserId: 3, groupId: 101, createTime: now });
    await migrateGenerationQueue(db);

    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let cancelCalls = 0;
    const handler: GenerationJobHandler = {
      key: "test.cancel-running",
      taskType: "text",
      canRetryAfterProviderSubmission: false,
      parsePayload: (value) => value,
      execute: async (context) => {
        startedResolve();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
        throw new Error("unreachable");
      },
      cancel: async () => { cancelCalls += 1; },
    };
    const registry = createGenerationJobRegistry([handler]);
    const job = await enqueueGeneration(actor, { projectId: 1001, handlerKey: handler.key, taskType: "text", payload: {}, idempotencyKey: "cancel-running" }, db);
    const claimed = await claimNextJob(101, { connection: db, leaseOwner: "cancel-worker", now });
    assert.equal(claimed?.id, job.id);
    const execution = executeClaimedJob(job.id, { connection: db, registry, heartbeatIntervalMs: 5 });
    await started;
    await cancelGenerationJob(actor, job.id, db);
    assert.notEqual((await db("o_generationJob").where({ id: job.id }).first()).cancellationRequestedAt, null);
    await Promise.race([
      execution,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("运行中取消未传播到 AbortSignal")), 500)),
    ]);

    const finished = await db("o_generationJob").where({ id: job.id }).first();
    assert.equal(finished.status, "cancelled");
    assert.notEqual(finished.finishedAt, null);
    assert.equal(finished.errorCode, null);
    assert.equal(finished.leaseOwner, null);
    assert.equal(cancelCalls, 1);
  } finally { await db.destroy(); }
}

main().then(() => { console.log("R3H running cancellation tests passed"); process.exit(0); }, (error) => { console.error(error); process.exit(1); });
