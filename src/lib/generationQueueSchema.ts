import type { Knex } from "knex";

export const generationQueueOrderingIndex = "o_generationJob_queue_order_idx";

export function addGenerationQueueOrderingIndex(
  table: Knex.CreateTableBuilder | Knex.AlterTableBuilder,
  knex: Knex,
): void {
  table.index(
    ["groupId", "status", knex.raw("priority DESC"), "queuedAt", "id"],
    generationQueueOrderingIndex,
  );
}

export async function ensureGenerationQueueOrderingIndex(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable("o_generationJob"))) return;
  const existing = await knex("sqlite_master")
    .where({ type: "index", tbl_name: "o_generationJob", name: generationQueueOrderingIndex })
    .first();
  if (existing) return;
  await knex.schema.alterTable("o_generationJob", (table) => {
    addGenerationQueueOrderingIndex(table, knex);
  });
}
