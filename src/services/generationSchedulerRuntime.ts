import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { GenerationJobRegistry } from "@/jobs/registry";
import { claimNextJob, executeClaimedJob, recoverExpiredJobs } from "@/services/generationScheduler";

export interface SchedulerRuntimeOptions {
  connection: Knex;
  registry: GenerationJobRegistry;
  intervalMs?: number;
}

export async function startGenerationScheduler(options: SchedulerRuntimeOptions): Promise<() => Promise<void>> {
  const workerId = `worker:${process.pid}:${randomUUID()}`;
  const active = new Set<Promise<void>>();
  let stopped = false;
  let ticking = false;
  await recoverExpiredJobs({ connection: options.connection, registry: options.registry });

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const groups = await options.connection("o_generationJob")
        .where({ status: "queued" })
        .distinct("groupId");
      for (const row of groups) {
        const job = await claimNextJob(Number(row.groupId), {
          connection: options.connection,
          leaseOwner: workerId,
        });
        if (!job) continue;
        const execution = executeClaimedJob(job.id, {
          connection: options.connection,
          registry: options.registry,
        }).finally(() => active.delete(execution));
        active.add(execution);
      }
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs ?? 500);
  void tick();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await Promise.allSettled([...active]);
  };
}
