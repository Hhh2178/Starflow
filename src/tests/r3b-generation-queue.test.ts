import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import { migrateGenerationQueue } from "@/lib/fixDB";

async function main(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, false);
    for (const table of [
      "o_concurrencyPolicy",
      "o_generationJob",
      "o_usageLedger",
      "o_quotaAccount",
      "o_quotaLedger",
    ]) {
      assert.equal(await db.schema.hasTable(table), true, `${table} must exist`);
    }

    for (const [table, column] of [
      ["o_concurrencyPolicy", "scopeType"],
      ["o_generationJob", "idempotencyKey"],
      ["o_generationJob", "leaseExpiresAt"],
      ["o_usageLedger", "jobId"],
      ["o_quotaAccount", "balance"],
      ["o_quotaLedger", "balanceAfter"],
    ] as const) {
      assert.equal(await db.schema.hasColumn(table, column), true, `${table}.${column} must exist`);
    }

    const now = Date.now();
    await db("o_group").insert([
      { id: 101, name: "A组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now },
      { id: 102, name: "B组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now },
    ]);
    await db("o_user").insert([
      { id: 1, name: "root", role: "super_admin", status: "enabled" },
      { id: 2, name: "admin-a", role: "admin", status: "enabled", groupId: 101 },
      { id: 3, name: "creator-a", role: "creator", status: "enabled", groupId: 101 },
    ]);

    await migrateGenerationQueue(db);
    assert.equal(await db("o_concurrencyPolicy").where({ scopeType: "group" }).count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_concurrencyPolicy").where({ scopeType: "user" }).count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_concurrencyPolicy").where({ scopeType: "user", scopeId: 1 }).first(), undefined);
    assert.equal(await db("o_quotaAccount").count({ count: "groupId" }).first().then((row) => Number(row?.count)), 2);

    const groupPolicy = await db("o_concurrencyPolicy").where({ scopeType: "group", scopeId: 101 }).first();
    assert.deepEqual(
      [groupPolicy.totalLimit, groupPolicy.textLimit, groupPolicy.imageLimit, groupPolicy.videoLimit],
      [4, 3, 2, 1],
    );
    await db("o_concurrencyPolicy").where({ scopeType: "group", scopeId: 101 }).update({ totalLimit: 7 });
    await migrateGenerationQueue(db);
    assert.equal((await db("o_concurrencyPolicy").where({ scopeType: "group", scopeId: 101 }).first()).totalLimit, 7);
    assert.equal(await db("o_concurrencyPolicy").count({ count: "id" }).first().then((row) => Number(row?.count)), 4);
  } finally {
    await db.destroy();
  }
}

main().then(
  () => {
    console.log("R3B generation queue schema tests passed");
    process.exit(0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
