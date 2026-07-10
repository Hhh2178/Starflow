import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import { migrateGenerationQueue } from "@/lib/fixDB";
import {
  ConcurrencyPolicyError,
  evaluateCapacity,
  getEffectivePolicies,
  updateGroupPolicy,
  updateUserPolicy,
} from "@/services/concurrencyPolicy";
import type { AuthUser } from "@/types/auth";

const zeroUsage = { total: 0, text: 0, image: 0, video: 0 };
const defaultGroupLimit = { total: 4, text: 3, image: 2, video: 1 };
const defaultUserLimit = { total: 2, text: 2, image: 1, video: 1 };

function testCapacityEvaluation(): void {
  assert.deepEqual(
    evaluateCapacity({
      taskType: "video",
      group: { ...zeroUsage, total: 4 },
      user: zeroUsage,
      groupLimit: defaultGroupLimit,
      userLimit: defaultUserLimit,
    }),
    { allowed: false, reason: "GROUP_TOTAL_LIMIT" },
  );
  assert.deepEqual(
    evaluateCapacity({
      taskType: "video",
      group: { ...zeroUsage, video: 1 },
      user: zeroUsage,
      groupLimit: defaultGroupLimit,
      userLimit: defaultUserLimit,
    }),
    { allowed: false, reason: "GROUP_TYPE_LIMIT" },
  );
  assert.deepEqual(
    evaluateCapacity({
      taskType: "video",
      group: zeroUsage,
      user: { ...zeroUsage, total: 2 },
      groupLimit: defaultGroupLimit,
      userLimit: defaultUserLimit,
    }),
    { allowed: false, reason: "USER_TOTAL_LIMIT" },
  );
  assert.deepEqual(
    evaluateCapacity({
      taskType: "video",
      group: zeroUsage,
      user: { ...zeroUsage, video: 1 },
      groupLimit: defaultGroupLimit,
      userLimit: defaultUserLimit,
    }),
    { allowed: false, reason: "USER_TYPE_LIMIT" },
  );
  assert.deepEqual(
    evaluateCapacity({
      taskType: "video",
      group: zeroUsage,
      user: zeroUsage,
      groupLimit: defaultGroupLimit,
      userLimit: defaultUserLimit,
    }),
    { allowed: true },
  );
}

async function expectPolicyError(
  operation: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(error instanceof ConcurrencyPolicyError, true);
    const policyError = error as ConcurrencyPolicyError;
    assert.equal(policyError.status, status);
    assert.equal(policyError.code, code);
    if (message !== undefined) assert.equal(policyError.message, message);
    return true;
  });
}

async function testPolicyAuthorization(db: ReturnType<typeof knex>): Promise<void> {
  const superAdmin: AuthUser = { id: 1, name: "root", role: "super_admin", groupId: null };
  const adminA: AuthUser = { id: 2, name: "admin-a", role: "admin", groupId: 101 };
  const creatorA: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };
  const validGroupLimit = { total: 6, text: 4, image: 3, video: 2 };

  assert.deepEqual(await updateGroupPolicy(superAdmin, 101, validGroupLimit, db), validGroupLimit);
  await expectPolicyError(
    updateGroupPolicy(adminA, 101, defaultGroupLimit, db),
    403,
    "SUPER_ADMIN_REQUIRED",
  );
  assert.deepEqual(await updateUserPolicy(superAdmin, 2, defaultUserLimit, db), defaultUserLimit);

  const creatorLimit = { total: 3, text: 2, image: 2, video: 1 };
  assert.deepEqual(await updateUserPolicy(adminA, 3, creatorLimit, db), creatorLimit);
  assert.deepEqual(await getEffectivePolicies(101, 3, db), { group: validGroupLimit, user: creatorLimit });

  await expectPolicyError(updateUserPolicy(adminA, 2, defaultUserLimit, db), 404, "USER_NOT_FOUND");
  await expectPolicyError(updateUserPolicy(adminA, 4, defaultUserLimit, db), 404, "USER_NOT_FOUND");
  await expectPolicyError(updateUserPolicy(creatorA, 3, defaultUserLimit, db), 403, "ADMIN_REQUIRED");
  await expectPolicyError(
    updateUserPolicy(adminA, 3, { total: 7, text: 2, image: 1, video: 1 }, db),
    422,
    "USER_TOTAL_EXCEEDS_GROUP",
    "个人总并发不能超过分组总并发",
  );
  await expectPolicyError(
    updateUserPolicy(adminA, 3, { total: 3, text: 2, image: 1, video: 3 }, db),
    422,
    "USER_TYPE_EXCEEDS_GROUP",
    "个人视频并发不能超过分组视频并发",
  );
}

async function main(): Promise<void> {
  testCapacityEvaluation();
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
      { id: 4, name: "creator-b", role: "creator", status: "enabled", groupId: 102 },
    ]);

    await migrateGenerationQueue(db);
    assert.equal(await db("o_concurrencyPolicy").where({ scopeType: "group" }).count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_concurrencyPolicy").where({ scopeType: "user" }).count({ count: "id" }).first().then((row) => Number(row?.count)), 3);
    assert.equal(await db("o_concurrencyPolicy").where({ scopeType: "user", scopeId: 1 }).first(), undefined);
    assert.equal(await db("o_quotaAccount").count({ count: "groupId" }).first().then((row) => Number(row?.count)), 2);

    const groupPolicy = await db("o_concurrencyPolicy").where({ scopeType: "group", scopeId: 101 }).first();
    assert.deepEqual(
      [groupPolicy.totalLimit, groupPolicy.textLimit, groupPolicy.imageLimit, groupPolicy.videoLimit],
      [4, 3, 2, 1],
    );
    await testPolicyAuthorization(db);
    await db("o_concurrencyPolicy").where({ scopeType: "group", scopeId: 101 }).update({ totalLimit: 7 });
    await migrateGenerationQueue(db);
    assert.equal((await db("o_concurrencyPolicy").where({ scopeType: "group", scopeId: 101 }).first()).totalLimit, 7);
    assert.equal(await db("o_concurrencyPolicy").count({ count: "id" }).first().then((row) => Number(row?.count)), 5);
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
