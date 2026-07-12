import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import express from "express";
import knex, { type Knex } from "knex";
import initDB from "@/lib/initDB";
import { migrateGenerationQueue } from "@/lib/fixDB";
import {
  adjustQuota,
  getQuotaOverview,
  QuotaManagementError,
  type QuotaAdjustmentInput,
} from "@/services/quotaManagement";
import {
  AuditLogError,
  listAudit,
  writeAudit,
  type AuditListInput,
} from "@/services/auditLog";
import { createAdjustQuotaRouter } from "@/routes/admin/quota/adjustQuota";
import { createGetOverviewRouter } from "@/routes/admin/quota/getOverview";
import { createListAuditRouter } from "@/routes/admin/audit/listAudit";
import type { AuthUser } from "@/types/auth";

const actors = {
  superAdmin: { id: 1, name: "root", role: "super_admin", groupId: null },
  adminA: { id: 2, name: "admin-a", role: "admin", groupId: 101 },
  creatorA: { id: 3, name: "creator-a", role: "creator", groupId: 101 },
  adminB: { id: 4, name: "admin-b", role: "admin", groupId: 102 },
  creatorB: { id: 5, name: "creator-b", role: "creator", groupId: 102 },
  adminA2: { id: 6, name: "admin-a-2", role: "admin", groupId: 101 },
} satisfies Record<string, AuthUser>;

async function expectServiceError(
  operation: Promise<unknown>,
  ErrorType: typeof QuotaManagementError | typeof AuditLogError,
  status: number,
  code: string,
): Promise<void> {
  await assert.rejects(operation, (cause: unknown) => {
    assert.equal(cause instanceof ErrorType, true);
    const error = cause as QuotaManagementError | AuditLogError;
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.match(error.message, /[\u4e00-\u9fff]/);
    return true;
  });
}

async function resetLedgers(db: Knex): Promise<void> {
  await db("o_auditLog").del();
  await db("o_quotaLedger").del();
  await db("o_quotaAccount").where({ groupId: 101 }).update({ balance: 0, updatedAt: 1 });
  await db("o_quotaAccount").where({ groupId: 102 }).update({ balance: 0, updatedAt: 1 });
}

async function testQuotaOverviewScopeAndAggregation(db: Knex): Promise<void> {
  await resetLedgers(db);
  const ledger = (
    groupId: number,
    entryType: string,
    amount: number,
    actorUserId: number | null,
    createdAt: number,
  ) => ({
    groupId,
    entryType,
    amount,
    balanceBefore: 0,
    balanceAfter: amount,
    actorUserId,
    usageLedgerId: null,
    reason: `ledger-${createdAt}`,
    createdAt,
  });
  await db("o_quotaLedger").insert([
    ledger(101, "manual_topup", 100, 1, 1),
    ledger(101, "manual_credit", 20, 2, 2),
    ledger(101, "manual_debit", -5, 1, 3),
    ledger(101, "usage_debit", -12, null, 4),
    ledger(101, "usage_debit", 3, null, 5),
    ledger(101, "recharge", 999, 1, 6),
    ledger(101, "manual_topup", -7, 1, 7),
    ledger(102, "manual_topup", 40, 4, 8),
    ledger(102, "usage_debit", -5, null, 9),
  ]);
  await db("o_quotaLedger").insert(
    Array.from({ length: 205 }, (_, index) => ledger(101, "manual_credit", 1, 2, 100 + index)),
  );
  await db("o_quotaLedger").insert(ledger(101, "manual_credit", 1, 1, 1_000));
  await db("o_quotaAccount").where({ groupId: 101 }).update({ balance: 306 });
  await db("o_quotaAccount").where({ groupId: 102 }).update({ balance: 35 });

  const superOverview = await getQuotaOverview(actors.superAdmin, db);
  assert.deepEqual(superOverview.groups.map((item) => item.groupId), [101, 102]);
  const groupA = superOverview.groups.find((item) => item.groupId === 101)!;
  assert.deepEqual(groupA, {
    groupId: 101,
    groupName: "A组",
    balance: 306,
    reservedBalance: 0,
    availableBalance: 306,
    billingStatus: "active",
    totalRecharge: 100,
    totalUsage: 15,
  });
  assert.deepEqual(superOverview.summary, {
    balance: 341,
    reservedBalance: 0,
    availableBalance: 341,
    billingStatus: "active",
    totalRecharge: 140,
    totalUsage: 20,
  });
  assert.equal(superOverview.logs.length, 200);
  assert.equal(superOverview.logs.some((item) => item.createdAt === 1), false);

  const adminOverview = await getQuotaOverview(actors.adminA, db);
  assert.deepEqual(adminOverview.groups.map((item) => item.groupId), [101]);
  assert.deepEqual(adminOverview.summary, {
    balance: 306,
    reservedBalance: 0,
    availableBalance: 306,
    billingStatus: "active",
    totalRecharge: 100,
    totalUsage: 15,
  });
  assert.equal(adminOverview.logs.every((item) => item.groupId === 101), true);
  assert.equal(adminOverview.logs.find((item) => item.createdAt === 1_000)?.actorUserId, null);
  const visibleAdminLog = adminOverview.logs.find((item) => item.actorUserId === actors.adminA.id);
  assert.ok(visibleAdminLog);

  await expectServiceError(
    getQuotaOverview(actors.creatorA, db),
    QuotaManagementError,
    403,
    "ADMIN_REQUIRED",
  );
}

async function testQuotaAdjustmentsAndRollback(db: Knex): Promise<void> {
  await resetLedgers(db);
  await db("o_quotaAccount").where({ groupId: 101 }).update({ balance: 10, updatedAt: 1 });

  const inputs: QuotaAdjustmentInput[] = [
    { groupId: 101, entryType: "manual_topup", amount: 50, reason: "首期充值" },
    { groupId: 101, entryType: "manual_credit", amount: 25, reason: "活动赠送" },
    { groupId: 101, entryType: "manual_debit", amount: 10, reason: "人工扣减" },
  ];
  const results = [];
  for (const input of inputs) results.push(await adjustQuota(actors.superAdmin, input, db));
  assert.deepEqual(results.map((item) => item.ledger.amount), [50, 25, -10]);
  assert.deepEqual(results.map((item) => item.account.balance), [60, 85, 75]);
  assert.deepEqual(Object.keys(results[0].account).sort(), ["balance", "groupId", "updatedAt"]);
  assert.deepEqual(Object.keys(results[0].ledger).sort(), [
    "actorUserId",
    "amount",
    "balanceAfter",
    "balanceBefore",
    "createdAt",
    "entryType",
    "groupId",
    "id",
    "reason",
    "usageLedgerId",
  ].sort());
  const overview = await getQuotaOverview(actors.superAdmin, db);
  const groupA = overview.groups.find((item) => item.groupId === 101)!;
  assert.equal(groupA.balance, 75);
  assert.equal(groupA.totalRecharge, 50);

  await expectServiceError(
    adjustQuota(actors.adminA, { ...inputs[0], groupId: 102 }, db),
    QuotaManagementError,
    403,
    "SUPER_ADMIN_REQUIRED",
  );
  await expectServiceError(
    adjustQuota(actors.superAdmin, { ...inputs[0], groupId: 999 }, db),
    QuotaManagementError,
    404,
    "GROUP_NOT_FOUND",
  );
  await expectServiceError(
    adjustQuota(actors.superAdmin, { ...inputs[0], amount: 0 }, db),
    QuotaManagementError,
    422,
    "AMOUNT_INVALID",
  );

  const balanceBefore = Number((await db("o_quotaAccount").where({ groupId: 101 }).first()).balance);
  const ledgerCountBefore = Number((await db("o_quotaLedger").count({ count: "id" }).first())?.count);
  await db.raw(`
    CREATE TRIGGER fail_quota_adjust_audit
    BEFORE INSERT ON o_auditLog
    WHEN NEW.action = 'quota.adjust'
    BEGIN
      SELECT RAISE(ABORT, 'forced audit failure');
    END
  `);
  await assert.rejects(
    adjustQuota(
      actors.superAdmin,
      { groupId: 101, entryType: "manual_credit", amount: 8, reason: "回滚测试" },
      db,
    ),
    /forced audit failure/,
  );
  await db.raw("DROP TRIGGER fail_quota_adjust_audit");
  assert.equal(Number((await db("o_quotaAccount").where({ groupId: 101 }).first()).balance), balanceBefore);
  assert.equal(Number((await db("o_quotaLedger").count({ count: "id" }).first())?.count), ledgerCountBefore);
}

async function testQuotaMicroUnitArithmetic(db: Knex): Promise<void> {
  await resetLedgers(db);
  const [first, second] = await Promise.all([
    adjustQuota(
      actors.superAdmin,
      { groupId: 101, entryType: "manual_topup", amount: 0.1, reason: "并发充值一" },
      db,
    ),
    adjustQuota(
      actors.superAdmin,
      { groupId: 101, entryType: "manual_credit", amount: 0.2, reason: "并发调额二" },
      db,
    ),
  ]);
  assert.deepEqual([first.ledger.amount, second.ledger.amount].sort(), [0.1, 0.2]);
  const account = await db("o_quotaAccount").where({ groupId: 101 }).first();
  assert.equal(Number(account.balance), 0.3);
  const ledgers = await db("o_quotaLedger").where({ groupId: 101 }).orderBy("id", "asc");
  assert.equal(ledgers.length, 2);
  assert.equal(Number(ledgers[0].balanceBefore), 0);
  assert.equal(Number(ledgers[0].balanceAfter), Number(ledgers[0].amount));
  assert.equal(Number(ledgers[1].balanceBefore), Number(ledgers[0].balanceAfter));
  assert.equal(Number(ledgers[1].balanceAfter), 0.3);
  const overview = await getQuotaOverview(actors.adminA, db);
  assert.deepEqual(overview.summary, {
    balance: 0.3,
    reservedBalance: 0,
    availableBalance: 0.3,
    billingStatus: "active",
    totalRecharge: 0.1,
    totalUsage: 0,
  });

  await expectServiceError(
    adjustQuota(
      actors.superAdmin,
      { groupId: 101, entryType: "manual_credit", amount: 0.0000001, reason: "超精度" },
      db,
    ),
    QuotaManagementError,
    422,
    "AMOUNT_PRECISION_INVALID",
  );
  await expectServiceError(
    adjustQuota(
      actors.superAdmin,
      { groupId: 101, entryType: "manual_credit", amount: 999_999_999.9999995, reason: "大额超精度" },
      db,
    ),
    QuotaManagementError,
    422,
    "AMOUNT_PRECISION_INVALID",
  );
  await expectServiceError(
    adjustQuota(
      actors.superAdmin,
      { groupId: 101, entryType: "manual_credit", amount: 1_000_000_001, reason: "超上限" },
      db,
    ),
    QuotaManagementError,
    422,
    "AMOUNT_TOO_LARGE",
  );
}

async function seedAuditRows(db: Knex): Promise<void> {
  await db("o_auditLog").del();
  await db("o_auditLog").insert([
    {
      actorUserId: 1,
      actorRole: "super_admin",
      groupId: 101,
      action: "quota.adjust",
      targetType: "quota_account",
      targetId: "101",
      summaryJson: JSON.stringify({ amount: 50, reason: "平台充值", apiKey: "secret-key" }),
      result: "success",
      requestId: "request-super",
      createdAt: 10,
    },
    {
      actorUserId: 2,
      actorRole: "admin",
      groupId: 101,
      action: "user.update",
      targetType: "user",
      targetId: "3",
      targetRole: "creator",
      summaryJson: JSON.stringify({ name: "creator-a", route: "/users", password: "secret-password", token: "secret-token" }),
      result: "success",
      requestId: "request-admin-a",
      createdAt: 20,
    },
    {
      actorUserId: 4,
      actorRole: "admin",
      groupId: 102,
      action: "user.update",
      targetType: "user",
      targetId: "5",
      targetRole: "creator",
      summaryJson: JSON.stringify({ name: "creator-b" }),
      result: "failure",
      requestId: null,
      createdAt: 30,
    },
    {
      actorUserId: 2,
      actorRole: "admin",
      groupId: 101,
      action: "user.update",
      targetType: "user",
      targetId: "6",
      targetRole: "admin",
      summaryJson: JSON.stringify({ name: "admin-a-2" }),
      result: "success",
      requestId: "request-admin-target",
      createdAt: 21,
    },
    {
      actorUserId: 2,
      actorRole: "admin",
      groupId: 101,
      action: "user.update",
      targetType: "user",
      targetId: "1",
      targetRole: "super_admin",
      summaryJson: JSON.stringify({ name: "root" }),
      result: "success",
      requestId: "request-super-target",
      createdAt: 22,
    },
    {
      actorUserId: 2,
      actorRole: "admin",
      groupId: 101,
      action: "user.update",
      targetType: "user",
      targetId: "3",
      targetRole: null,
      summaryJson: JSON.stringify({ name: "legacy-creator" }),
      result: "success",
      requestId: "request-legacy-target-role",
      createdAt: 23,
    },
  ]);
}

async function testAuditScopeAndRedaction(db: Knex): Promise<void> {
  await seedAuditRows(db);
  const superList = await listAudit(actors.superAdmin, { page: 1, pageSize: 100 }, db);
  assert.equal(superList.total, 6);
  assert.deepEqual(superList.items.map((item: any) => item.groupId), [102, 101, 101, 101, 101, 101]);
  const quotaAudit = superList.items.find((item: any) => item.action === "quota.adjust")!;
  assert.equal(quotaAudit.actionLabel, "额度调整");
  assert.equal(quotaAudit.actorRoleLabel, "超级管理员");
  assert.equal(quotaAudit.resultLabel, "成功");
  assert.equal("summaryJson" in quotaAudit, false);
  assert.equal(JSON.stringify(quotaAudit.summary).includes("secret-key"), false);

  const adminList = await listAudit(
    actors.adminA,
    { page: 1, pageSize: 20, groupId: 102 },
    db,
  );
  assert.equal(adminList.total, 1);
  assert.equal(adminList.items.every((item: any) => item.groupId === 101), true);
  assert.equal(adminList.items.every((item: any) => item.actorRole !== "super_admin"), true);
  assert.deepEqual(adminList.items.map((item: any) => item.targetId), ["3"]);
  const serialized = JSON.stringify(adminList);
  for (const forbidden of ["summaryJson", "secret-password", "secret-token", "password", "apiKey", "token"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must be redacted`);
  }

  await expectServiceError(
    listAudit(actors.creatorA, {}, db),
    AuditLogError,
    403,
    "ADMIN_REQUIRED",
  );
  await expectServiceError(
    listAudit(actors.superAdmin, { page: 1, pageSize: 101 }, db),
    AuditLogError,
    422,
    "PAGE_SIZE_INVALID",
  );
}

async function testAuditTargetRoleSnapshots(db: Knex): Promise<void> {
  await seedAuditRows(db);
  await writeAudit({
    actor: actors.adminA,
    groupId: 101,
    action: "user.update",
    targetType: "user",
    targetId: 6,
    summary: { name: "admin-a-2" },
    result: "success",
  }, db);
  const snapshot = await db("o_auditLog")
    .where({ action: "user.update", targetId: "6" })
    .orderBy("id", "desc")
    .first();
  assert.equal(snapshot.targetRole, "admin");
  await assert.rejects(
    writeAudit({
      actor: actors.adminA,
      groupId: 101,
      action: "user.update",
      targetType: "user",
      targetId: 3,
      targetRole: "admin",
      summary: {},
      result: "success",
    }, db),
    (cause: unknown) => cause instanceof AuditLogError && cause.code === "TARGET_ROLE_MISMATCH",
  );

  await db("o_user").where({ id: 6 }).update({ role: "creator" });
  let adminList = await listAudit(actors.adminA, { page: 1, pageSize: 100 }, db);
  assert.equal(adminList.items.some((item: any) => item.targetId === "6"), false);
  await db("o_user").where({ id: 6 }).del();
  adminList = await listAudit(actors.adminA, { page: 1, pageSize: 100 }, db);
  assert.equal(adminList.items.some((item: any) => item.targetId === "6"), false);
  assert.equal(adminList.items.some((item: any) => item.requestId === "request-legacy-target-role"), false);
}

async function requestJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function testAdminRoutes(db: Knex): Promise<void> {
  await seedAuditRows(db);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const key = String(req.headers["x-test-actor"] ?? "superAdmin") as keyof typeof actors;
    (req as any).user = actors[key];
    next();
  });
  app.use(
    "/api/admin/quota/adjustQuota",
    createAdjustQuotaRouter((actor, input) => adjustQuota(actor, input, db)),
  );
  app.use(
    "/api/admin/quota/getOverview",
    createGetOverviewRouter((actor) => getQuotaOverview(actor, db)),
  );
  app.use(
    "/api/admin/audit/listAudit",
    createListAuditRouter((actor, input) => listAudit(actor, input, db)),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const quotaUrl = `http://127.0.0.1:${port}/api/admin/quota/adjustQuota`;
    const overviewUrl = `http://127.0.0.1:${port}/api/admin/quota/getOverview`;
    const auditUrl = `http://127.0.0.1:${port}/api/admin/audit/listAudit`;
    const validAdjustment = {
      groupId: 101,
      entryType: "manual_credit",
      amount: 5,
      reason: "路由调额",
    };
    for (const payload of [
      { ...validAdjustment, amount: 0 },
      { ...validAdjustment, entryType: "usage_debit" },
      { ...validAdjustment, extra: true },
      { ...validAdjustment, reason: "x" },
      { ...validAdjustment, amount: 0.0000001 },
      { ...validAdjustment, amount: 1_000_000_001 },
    ]) {
      const response = await requestJson(quotaUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400);
      assert.match(response.body.message, /参数/);
    }

    for (const actor of ["adminA", "creatorA"] as const) {
      const response = await requestJson(quotaUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-actor": actor },
        body: JSON.stringify({ ...validAdjustment, groupId: 102 }),
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.data.code, "SUPER_ADMIN_REQUIRED");
    }
    const missingGroup = await requestJson(quotaUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validAdjustment, groupId: 999 }),
    });
    assert.equal(missingGroup.status, 404);
    assert.equal(missingGroup.body.data.code, "GROUP_NOT_FOUND");
    const adjusted = await requestJson(quotaUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validAdjustment),
    });
    assert.equal(adjusted.status, 200);
    assert.equal(adjusted.body.message, "额度调整成功");
    assert.equal(adjusted.body.data.ledger.amount, 5);

    const superOverview = await requestJson(overviewUrl);
    assert.equal(superOverview.status, 200);
    assert.deepEqual(superOverview.body.data.groups.map((item: any) => item.groupId), [101, 102]);
    assert.deepEqual(
      superOverview.body.data.summary,
      (await getQuotaOverview(actors.superAdmin, db)).summary,
    );
    const adminOverview = await requestJson(overviewUrl, { headers: { "x-test-actor": "adminA" } });
    assert.equal(adminOverview.status, 200);
    assert.deepEqual(adminOverview.body.data.groups.map((item: any) => item.groupId), [101]);
    assert.deepEqual(
      adminOverview.body.data.summary,
      (await getQuotaOverview(actors.adminA, db)).summary,
    );
    const creatorOverview = await requestJson(overviewUrl, { headers: { "x-test-actor": "creatorA" } });
    assert.equal(creatorOverview.status, 403);
    assert.equal(creatorOverview.body.data.code, "ADMIN_REQUIRED");

    const adminAudit = await requestJson(`${auditUrl}?page=1&pageSize=20&groupId=102`, {
      headers: { "x-test-actor": "adminA" },
    });
    assert.equal(adminAudit.status, 200);
    assert.equal(adminAudit.body.data.items.every((item: any) => item.groupId === 101), true);
    assert.equal(adminAudit.body.data.items.every((item: any) => item.actorRole !== "super_admin"), true);
    const creatorAudit = await requestJson(auditUrl, { headers: { "x-test-actor": "creatorA" } });
    assert.equal(creatorAudit.status, 403);
    assert.equal(creatorAudit.body.data.code, "ADMIN_REQUIRED");
    for (const query of ["?pageSize=101", "?page=0", "?extra=true"]) {
      const response = await requestJson(`${auditUrl}${query}`);
      assert.equal(response.status, 400);
      assert.match(response.body.message, /参数/);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function testGeneratedOverviewRouteAssembly(): Promise<void> {
  const routerSource = await readFile("src/router.ts", "utf8");
  assert.match(routerSource, /from "\.\/routes\/admin\/quota\/getOverview"/);
  assert.match(routerSource, /app\.use\("\/api\/admin\/quota\/getOverview", route\d+\)/);

  const { default: registerRoutes } = await import("@/router");
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = actors.creatorA;
    next();
  });
  await registerRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await requestJson(`http://127.0.0.1:${port}/api/admin/quota/getOverview`);
    assert.equal(response.status, 403);
    assert.equal(response.body.data.code, "ADMIN_REQUIRED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function main(): Promise<void> {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, false);
    const now = Date.now();
    await db("o_group").insert([
      { id: 101, name: "A组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now },
      { id: 102, name: "B组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now },
    ]);
    await db("o_user").insert([
      { ...actors.superAdmin, status: "enabled", groupId: null },
      { ...actors.adminA, status: "enabled" },
      { ...actors.creatorA, status: "enabled" },
      { ...actors.adminB, status: "enabled" },
      { ...actors.creatorB, status: "enabled" },
      { ...actors.adminA2, status: "enabled" },
    ]);
    await migrateGenerationQueue(db);
    await testQuotaOverviewScopeAndAggregation(db);
    await testQuotaAdjustmentsAndRollback(db);
    await testQuotaMicroUnitArithmetic(db);
    await testAuditScopeAndRedaction(db);
    await testAuditTargetRoleSnapshots(db);
    await testAdminRoutes(db);
    await testGeneratedOverviewRouteAssembly();
  } finally {
    await db.destroy();
  }
}

main().then(
  () => {
    console.log("R3D admin operations tests passed");
    process.exit(0);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
