import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import { seedAcceptanceFixture } from "@/services/acceptanceFixture";

async function main() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, true);
    await assert.rejects(seedAcceptanceFixture(db, "short"), /至少 8 个字符/);
    const first = await seedAcceptanceFixture(db, "AcceptancePass123", 10_000);
    const second = await seedAcceptanceFixture(db, "AcceptancePass123", 20_000);
    assert.deepEqual(second.groups.map((group) => group.name), ["验收一组", "验收二组"]);
    assert.deepEqual(second.users.map((user) => user.name), [
      "accept-admin-a", "accept-creator-a1", "accept-creator-a2",
      "accept-admin-b", "accept-creator-b1", "accept-creator-b2",
    ]);
    assert.deepEqual(second.groups.map((group) => group.id), first.groups.map((group) => group.id));
    assert.deepEqual(second.users.map((user) => user.id), first.users.map((user) => user.id));

    assert.equal(await db("o_group").whereIn("name", ["验收一组", "验收二组"]).count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_user").where("name", "like", "accept-%").count({ count: "id" }).first().then((row) => Number(row?.count)), 6);
    assert.equal(await db("o_project").where("name", "like", "验收%项目").count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_tasks").where("relatedObjects", "like", "acceptance:%").count({ count: "id" }).first().then((row) => Number(row?.count)), 4);
    assert.equal(await db("o_generationJob").where("idempotencyKey", "like", "acceptance:%").count({ count: "id" }).first().then((row) => Number(row?.count)), 6);
    assert.equal(await db("o_usageLedger").whereIn("jobId", second.jobIds).count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_quotaLedger").where("reason", "本地验收 fixture 初始额度").count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_quotaLedger").where({ entryType: "usage_debit" }).where("reason", "like", "本地验收 fixture 用量扣款:%").count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    const balances = await db("o_quotaAccount").whereIn("groupId", second.groups.map((group) => group.id)).orderBy("groupId").pluck("balance");
    assert.deepEqual(balances.map(Number), [498.75, 497.5]);
    assert.equal((await db("o_user").where({ name: "accept-admin-a" }).first()).password, null);
    assert.notEqual((await db("o_user").where({ name: "accept-admin-a" }).first()).passwordHash, "AcceptancePass123");
  } finally {
    await db.destroy();
  }
}

main().then(
  () => { console.log("R3F acceptance fixture tests passed"); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);
