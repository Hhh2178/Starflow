import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import { createAcceptanceGenerationRegistry } from "@/jobs/acceptanceRegistry";
import { getUsageOverview } from "@/services/adminMonitoring";
import { seedAcceptanceFixture } from "@/services/acceptanceFixture";
import { startGenerationScheduler } from "@/services/generationSchedulerRuntime";
import { estimateModelPricing, resolvePricingTarget } from "@/services/modelPricing";
import { verifyPassword } from "@/utils/password";

async function fixtureBillingState(db: ReturnType<typeof knex>, groupIds: number[]) {
  return {
    activePrices: await db("o_modelPricing").where({ providerId: "null", status: "active" }).count({ count: "id" }).first().then((row) => Number(row?.count)),
    reservations: await db("o_quotaReservation").count({ count: "id" }).first().then((row) => Number(row?.count)),
    usageDebits: await db("o_quotaLedger").where({ entryType: "usage_debit" }).where("reason", "like", "本地验收 fixture 用量扣款:%").count({ count: "id" }).first().then((row) => Number(row?.count)),
    accounts: await db("o_quotaAccount").whereIn("groupId", groupIds).orderBy("groupId").select("balance", "reservedBalance", "billingStatus").then((rows) => rows.map((row) => ({ balance: Number(row.balance), reservedBalance: Number(row.reservedBalance), billingStatus: row.billingStatus }))),
  };
}

async function fixtureImmutablePricingState(db: ReturnType<typeof knex>) {
  const pricingJobs = await db("o_generationJob")
    .whereIn("idempotencyKey", ["acceptance:pricing-request", "acceptance:pricing-second", "acceptance:pricing-token"])
    .orderBy("idempotencyKey")
    .select("id", "idempotencyKey", "pricingSnapshotJson", "reservedAmount");
  const pricedUsage = await db("o_usageLedger")
    .whereIn("jobId", pricingJobs.map((job) => job.id))
    .orderBy("jobId")
    .select("jobId", "providerId", "modelId", "taskType", "unitJson", "estimatedCost", "currency", "pricingSnapshotJson", "result", "createdAt");
  const pricingReservations = await db("o_quotaReservation")
    .whereIn("jobId", pricingJobs.map((job) => job.id))
    .orderBy("jobId")
    .select("jobId", "pricingId", "reservedAmount", "finalAmount", "status", "reason", "createdAt", "settledAt", "releasedAt");
  return {
    prices: await db("o_modelPricing")
      .where({ providerId: "null", version: 1 })
      .whereIn("modelId", ["acceptance-text", "acceptance-image", "acceptance-video"])
      .orderBy("modelId"),
    pricingJobs,
    pricingReservations: pricingReservations.map((reservation) => ({
      jobId: Number(reservation.jobId),
      pricingId: Number(reservation.pricingId),
      reservedAmount: Number(reservation.reservedAmount),
      finalAmount: reservation.finalAmount == null ? null : Number(reservation.finalAmount),
      status: reservation.status,
      reason: reservation.reason,
      createdAt: Number(reservation.createdAt),
      settledAt: reservation.settledAt == null ? null : Number(reservation.settledAt),
      releasedAt: reservation.releasedAt == null ? null : Number(reservation.releasedAt),
    })),
    pricedUsage,
  };
}

async function pricingSecondRuntimeState(db: ReturnType<typeof knex>) {
  const job = await db("o_generationJob").where({ idempotencyKey: "acceptance:pricing-second" }).first();
  const reservation = await db("o_quotaReservation").where({ jobId: job.id }).first();
  const account = await db("o_quotaAccount").where({ groupId: job.groupId }).first();
  return {
    job: {
      status: job.status,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      attemptCount: Number(job.attemptCount),
      startedAt: job.startedAt == null ? null : Number(job.startedAt),
      finishedAt: job.finishedAt == null ? null : Number(job.finishedAt),
      providerRequestId: job.providerRequestId,
      leaseOwner: job.leaseOwner,
      leaseExpiresAt: job.leaseExpiresAt,
      heartbeatAt: job.heartbeatAt,
    },
    reservation: {
      jobId: Number(reservation.jobId),
      pricingId: Number(reservation.pricingId),
      reservedAmount: Number(reservation.reservedAmount),
      finalAmount: reservation.finalAmount == null ? null : Number(reservation.finalAmount),
      status: reservation.status,
      reason: reservation.reason,
      createdAt: Number(reservation.createdAt),
      settledAt: reservation.settledAt == null ? null : Number(reservation.settledAt),
      releasedAt: reservation.releasedAt == null ? null : Number(reservation.releasedAt),
    },
    reservedBalance: Number(account.reservedBalance),
  };
}

async function main() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  let stopScheduler: (() => Promise<void>) | null = null;
  try {
    await initDB(db, false, true);
    const initialSuperAdmin = await db("o_user").where({ role: "super_admin" }).first();
    assert.ok(initialSuperAdmin);
    await assert.rejects(seedAcceptanceFixture(db, "short"), /至少 8 个字符/);
    const acceptancePassword = "AcceptancePass123";
    const first = await seedAcceptanceFixture(db, acceptancePassword, 10_000);
    const seededSuperAdmin = await db("o_user").where({ id: initialSuperAdmin.id }).first();
    assert.equal(seededSuperAdmin.role, initialSuperAdmin.role);
    assert.equal(seededSuperAdmin.groupId, initialSuperAdmin.groupId);
    assert.equal(seededSuperAdmin.status, "enabled");
    assert.equal(seededSuperAdmin.mustChangePassword, 1);
    assert.equal(seededSuperAdmin.password, null);
    assert.notEqual(seededSuperAdmin.passwordHash, acceptancePassword);
    assert.equal(verifyPassword(acceptancePassword, seededSuperAdmin.passwordHash), true);
    assert.equal(verifyPassword("WrongAcceptancePass123", seededSuperAdmin.passwordHash), false);
    const acceptanceAliases = ["productionAgent", "scriptAgent", "universalAi"];
    const firstAliasRows = await db("o_agentDeploy")
      .whereIn("key", acceptanceAliases)
      .orderBy("key")
      .select("id", "key", "name", "desc", "model", "modelName", "vendorId", "temperature", "maxOutputTokens", "disabled");
    assert.equal(firstAliasRows.length, 3);
    for (const alias of acceptanceAliases) {
      assert.deepEqual(await resolvePricingTarget("text", alias, db), {
        providerId: "null",
        modelId: "acceptance-text",
        canonicalModel: "null:acceptance-text",
      });
    }
    const creatorA1 = first.users.find((user) => user.name === "accept-creator-a1")!;
    const fallbackEstimate = await estimateModelPricing(
      { id: creatorA1.id, name: creatorA1.name, role: "creator", groupId: creatorA1.groupId },
      { taskType: "text", model: "universalAi", units: { requests: 2 } },
      db,
    );
    assert.equal(fallbackEstimate.canonicalModel, "null:acceptance-text");
    assert.equal(fallbackEstimate.estimatedCost, 0.1);
    const firstBillingState = await fixtureBillingState(db, first.groups.map((group) => group.id));
    const firstImmutablePricingState = await fixtureImmutablePricingState(db);
    const second = await seedAcceptanceFixture(db, acceptancePassword, 20_000);
    assert.deepEqual(
      await db("o_agentDeploy")
        .whereIn("key", acceptanceAliases)
        .orderBy("key")
        .select("id", "key", "name", "desc", "model", "modelName", "vendorId", "temperature", "maxOutputTokens", "disabled"),
      firstAliasRows,
    );
    assert.deepEqual(await fixtureBillingState(db, second.groups.map((group) => group.id)), firstBillingState);
    assert.deepEqual(await fixtureImmutablePricingState(db), firstImmutablePricingState);
    stopScheduler = await startGenerationScheduler({
      connection: db,
      registry: createAcceptanceGenerationRegistry({ connection: db, delayMs: 0 }),
      intervalMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await stopScheduler();
    stopScheduler = null;
    const runtimeState = await pricingSecondRuntimeState(db);
    assert.deepEqual(runtimeState.job, {
      status: "needs_attention",
      errorCode: "EXTERNAL_STATE_UNKNOWN",
      errorMessage: "Provider 外部状态未知，需要人工处理",
      attemptCount: 1,
      startedAt: 5_000,
      finishedAt: 6_000,
      providerRequestId: "fixture:pricing-second:external-state",
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
    });
    assert.equal(runtimeState.reservation.status, "reserved");
    assert.equal(runtimeState.reservation.reservedAmount, 0.18);
    assert.equal(runtimeState.reservedBalance, 0.18);
    await seedAcceptanceFixture(db, acceptancePassword, 30_000);
    assert.deepEqual(await pricingSecondRuntimeState(db), runtimeState);
    const pricingSecondJob = await db("o_generationJob").where({ idempotencyKey: "acceptance:pricing-second" }).first();
    await db("o_generationJob").where({ id: pricingSecondJob.id }).update({
      status: "needs_attention",
      errorCode: "HANDLER_NOT_FOUND",
      errorMessage: "找不到可信的任务处理器",
      providerRequestId: null,
    });
    await db("o_quotaReservation").where({ jobId: pricingSecondJob.id }).update({
      finalAmount: 0,
      status: "released",
      reason: "handler_not_found",
      settledAt: null,
      releasedAt: 31_000,
    });
    await db("o_quotaAccount").where({ groupId: pricingSecondJob.groupId }).update({ reservedBalance: 0 });
    await seedAcceptanceFixture(db, acceptancePassword, 40_000);
    const upgradedRuntimeState = await pricingSecondRuntimeState(db);
    assert.equal(upgradedRuntimeState.job.status, "needs_attention");
    assert.equal(upgradedRuntimeState.job.errorCode, "EXTERNAL_STATE_UNKNOWN");
    assert.equal(upgradedRuntimeState.reservation.status, "reserved");
    assert.equal(upgradedRuntimeState.reservation.finalAmount, null);
    assert.equal(upgradedRuntimeState.reservation.reason, null);
    assert.equal(upgradedRuntimeState.reservation.settledAt, null);
    assert.equal(upgradedRuntimeState.reservation.releasedAt, null);
    assert.equal(upgradedRuntimeState.reservedBalance, 0.18);
    await seedAcceptanceFixture(db, acceptancePassword, 50_000);
    assert.deepEqual(await pricingSecondRuntimeState(db), upgradedRuntimeState);
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
    const acceptanceProjects = await db("o_project")
      .where("name", "like", "验收%项目")
      .orderBy("id")
      .select("projectType", "imageModel", "imageQuality", "videoModel");
    assert.deepEqual(acceptanceProjects, [
      { projectType: "novel", imageModel: "null:acceptance-image", imageQuality: "1K", videoModel: "null:acceptance-video" },
      { projectType: "novel", imageModel: "null:acceptance-image", imageQuality: "1K", videoModel: "null:acceptance-video" },
    ]);
    const acceptanceVendor = await db("o_vendorConfig").where({ id: "null" }).first();
    assert.equal(acceptanceVendor.enable, 1);
    assert.deepEqual(JSON.parse(acceptanceVendor.models), [
      { name: "本地验收文本", modelName: "acceptance-text", type: "text" },
      { name: "本地验收图片", modelName: "acceptance-image", type: "image", mode: ["text", "singleImage", "multiReference"] },
      { name: "本地验收视频", modelName: "acceptance-video", type: "video", mode: ["text", "singleImage"], audio: false, durationResolutionMap: [{ duration: [5], resolution: ["720p"] }] },
    ]);
    assert.deepEqual(JSON.parse(acceptanceVendor.inputValues), {});
    assert.equal(await db("o_tasks").where("relatedObjects", "like", "acceptance:%").count({ count: "id" }).first().then((row) => Number(row?.count)), 4);
    assert.equal(await db("o_script").where("name", "like", "验收%剧本").count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_assets").where("name", "like", "验收%角色").count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_storyboard").where("prompt", "like", "验收%分镜提示词").count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_videoTrack").where("prompt", "like", "验收%视频提示词").count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_agentWorkData").where({ key: "acceptance-production" }).count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_generationJob").where("idempotencyKey", "like", "acceptance:%").count({ count: "id" }).first().then((row) => Number(row?.count)), 9);
    assert.equal(await db("o_usageLedger").whereIn("jobId", second.jobIds).count({ count: "id" }).first().then((row) => Number(row?.count)), 3);
    assert.equal(await db("o_quotaLedger").where("reason", "本地验收 fixture 初始额度").count({ count: "id" }).first().then((row) => Number(row?.count)), 2);
    assert.equal(await db("o_quotaLedger").where({ entryType: "usage_debit" }).where("reason", "like", "本地验收 fixture 用量扣款:%").count({ count: "id" }).first().then((row) => Number(row?.count)), 3);

    const pricing = await db("o_modelPricing")
      .where({ providerId: "null", status: "active" })
      .whereIn("modelId", ["acceptance-text", "acceptance-image", "acceptance-video"])
      .orderBy("modelId")
      .select("modelId", "taskType", "billingMode", "requestPrice", "secondPrice", "inputPricePerMillion", "outputPricePerMillion", "fallbackRequestPrice", "currency", "version");
    assert.deepEqual(pricing.map((row) => ({ ...row, requestPrice: row.requestPrice == null ? null : Number(row.requestPrice), secondPrice: row.secondPrice == null ? null : Number(row.secondPrice), inputPricePerMillion: row.inputPricePerMillion == null ? null : Number(row.inputPricePerMillion), outputPricePerMillion: row.outputPricePerMillion == null ? null : Number(row.outputPricePerMillion), fallbackRequestPrice: row.fallbackRequestPrice == null ? null : Number(row.fallbackRequestPrice) })), [
      { modelId: "acceptance-image", taskType: "image", billingMode: "per_request", requestPrice: 0.06, secondPrice: null, inputPricePerMillion: null, outputPricePerMillion: null, fallbackRequestPrice: null, currency: "CNY", version: 1 },
      { modelId: "acceptance-text", taskType: "text", billingMode: "per_token", requestPrice: null, secondPrice: null, inputPricePerMillion: 1, outputPricePerMillion: 2, fallbackRequestPrice: 0.05, currency: "CNY", version: 1 },
      { modelId: "acceptance-video", taskType: "video", billingMode: "per_second", requestPrice: null, secondPrice: 0.036, inputPricePerMillion: null, outputPricePerMillion: null, fallbackRequestPrice: null, currency: "CNY", version: 1 },
    ]);

    const pricingJobs = await db("o_generationJob")
      .whereIn("idempotencyKey", ["acceptance:pricing-request", "acceptance:pricing-second", "acceptance:pricing-token"])
      .orderBy("idempotencyKey")
      .select("id", "idempotencyKey", "status", "pricingSnapshotJson", "reservedAmount");
    assert.equal(pricingJobs.length, 3);
    assert.equal(new Set(pricingJobs.map((job) => Number(job.id))).size, 3);
    assert.deepEqual(pricingJobs.map((job) => JSON.parse(job.pricingSnapshotJson).billingMode), ["per_request", "per_second", "per_token"]);
    assert.deepEqual(pricingJobs.map((job) => Number(job.reservedAmount)), [0.06, 0.18, 0.05]);
    const reservations = await db("o_quotaReservation").whereIn("jobId", pricingJobs.map((job) => job.id)).orderBy("jobId");
    assert.equal(reservations.length, 3);
    assert.equal(new Set(reservations.map((reservation) => Number(reservation.jobId))).size, 3);
    assert.deepEqual(reservations.map((reservation) => reservation.status).sort(), ["released", "reserved", "settled"]);

    const accounts = await db("o_quotaAccount")
      .whereIn("groupId", second.groups.map((group) => group.id))
      .orderBy("groupId")
      .select("balance", "reservedBalance", "billingStatus");
    assert.deepEqual(accounts.map((account) => ({ balance: Number(account.balance), reservedBalance: Number(account.reservedBalance), billingStatus: account.billingStatus })), [
      { balance: 498.69, reservedBalance: 0, billingStatus: "active" },
      { balance: 497.5, reservedBalance: 0.18, billingStatus: "active" },
    ]);

    const usageOverview = await getUsageOverview(
      { id: 1, name: "root", role: "super_admin", groupId: null },
      { page: 1, pageSize: 20 },
      db,
    );
    const legacyUsage = usageOverview.items.filter((item) => item.pricingSnapshot === null);
    assert.equal(legacyUsage.length, 2);
    assert.deepEqual(legacyUsage.map((item) => item.units), [{}, {}]);
    const pricedUsage = usageOverview.items.find((item) => item.billingMode === "per_request");
    assert.equal(pricedUsage?.finalCost, 0.06);
    assert.equal(pricedUsage?.pricingSnapshot?.requestPrice, 0.06);
    assert.equal((await db("o_user").where({ name: "accept-admin-a" }).first()).password, null);
    assert.notEqual((await db("o_user").where({ name: "accept-admin-a" }).first()).passwordHash, acceptancePassword);
    await db("o_user").where({ role: "super_admin" }).delete();
    await assert.rejects(seedAcceptanceFixture(db, acceptancePassword, 60_000), /未找到 Super Admin 验收账号/);
  } finally {
    if (stopScheduler) await stopScheduler();
    await db.destroy();
  }
}

main().then(
  () => { console.log("R3F acceptance fixture tests passed"); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);
