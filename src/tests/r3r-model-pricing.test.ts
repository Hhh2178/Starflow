import assert from "node:assert/strict";
import test from "node:test";
import knex, { Knex } from "knex";
import initDB from "@/lib/initDB";
import { migrateGenerationQueue } from "@/lib/fixDB";
import { cancelGenerationJob, enqueueGeneration, GenerationQueueError } from "@/services/generationQueue";
import { completeGenerationUsage } from "@/services/generationUsage";
import { adjustQuota } from "@/services/quotaManagement";
import { normalizeTextUsage } from "@/services/generationMetering";
import { composeRuntimeKitInput } from "@/services/providerRuntime/runtimeKit";
import {
  calculateActualCost,
  calculateReservedCost,
  estimateModelPricing,
  listModelPricing,
  ModelPricingError,
  resolvePricingTarget,
  updateModelPricing,
  validatePricingSnapshot,
  type PricingSnapshot,
} from "@/services/modelPricing";

function createTestDB(): Knex {
  return knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
}

function pricing(overrides: Partial<PricingSnapshot>): PricingSnapshot {
  return {
    pricingId: 1,
    providerId: "test",
    modelId: "test-model",
    taskType: "text",
    billingMode: "per_request",
    currency: "CNY",
    version: 1,
    effectiveAt: 1,
    ...overrides,
  };
}

test("pricing and reservation schema exists", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    await migrateGenerationQueue(db);

    assert.equal(await db.schema.hasTable("o_modelPricing"), true);
    assert.equal(await db.schema.hasTable("o_quotaReservation"), true);
    assert.equal(await db.schema.hasColumn("o_quotaAccount", "reservedBalance"), true);
    assert.equal(await db.schema.hasColumn("o_quotaAccount", "billingStatus"), true);
    assert.equal(await db.schema.hasColumn("o_generationJob", "pricingSnapshotJson"), true);
    assert.equal(await db.schema.hasColumn("o_generationJob", "reservedAmount"), true);
  } finally {
    await db.destroy();
  }
});

test("migration seeds the four approved prices once", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    await migrateGenerationQueue(db);
    await migrateGenerationQueue(db);

    const rows = await db("o_modelPricing")
      .where({ status: "active" })
      .orderBy(["providerId", "modelId"]);

    assert.deepEqual(
      rows.map(({ providerId, modelId, billingMode, requestPrice }) => ({
        providerId,
        modelId,
        billingMode,
        requestPrice: Number(requestPrice),
      })),
      [
        {
          providerId: "aicopy",
          modelId: "grok-imagine-video-1.5-preview",
          billingMode: "per_request",
          requestPrice: 0.18,
        },
        {
          providerId: "grsai",
          modelId: "gpt-image-2",
          billingMode: "per_request",
          requestPrice: 0.06,
        },
        {
          providerId: "mimo",
          modelId: "mimo-v2.5",
          billingMode: "per_request",
          requestPrice: 0.05,
        },
        {
          providerId: "mimo",
          modelId: "mimo-v2.5-pro",
          billingMode: "per_request",
          requestPrice: 0.05,
        },
      ],
    );
  } finally {
    await db.destroy();
  }
});

test("pricing formulas use exact CNY arithmetic and Token fallback", () => {
  assert.equal(
    calculateReservedCost(pricing({ billingMode: "per_request", requestPrice: 0.18 }), { requests: 1 }),
    0.18,
  );
  assert.equal(
    calculateActualCost(pricing({ billingMode: "per_second", secondPrice: 0.03 }), { seconds: 6 }),
    0.18,
  );
  assert.equal(
    calculateActualCost(
      pricing({
        billingMode: "per_token",
        inputPricePerMillion: 2,
        outputPricePerMillion: 8,
        fallbackRequestPrice: 0.05,
      }),
      { inputTokens: 125_000, outputTokens: 25_000 },
    ),
    0.45,
  );
  assert.equal(
    calculateActualCost(
      pricing({
        billingMode: "per_token",
        inputPricePerMillion: 2,
        outputPricePerMillion: 8,
        fallbackRequestPrice: 0.05,
      }),
      { inputTokens: 125_000 },
    ),
    0.05,
  );
});

test("runtime composition cannot change pricing reservation or settlement inputs", () => {
  const snapshot = pricing({ providerId: "mimo", modelId: "mimo-v2.5", requestPrice: 0.05 });
  const before = structuredClone(snapshot);
  const reserved = calculateReservedCost(snapshot, { requests: 1 });
  composeRuntimeKitInput({
    request: { providerId: "mimo", modelId: "mimo-v2.5", capability: "text", input: { messages: [], parameters: { temperature: 0.2 } }, timeoutMs: 1000 },
    provider: { providerId: "mimo", displayName: "MiMo", enabled: true, migrationState: "native", adapterId: "runtime-kit", advancedConfig: { request: { fixedBody: { region: "cn" } } } },
    model: { providerId: "mimo", modelId: "mimo-v2.5", displayName: "MiMo", capability: "text", parameterSchema: { temperature: { type: "number", min: 0, max: 2 } }, enabled: true },
    protocol: { providerId: "mimo", protocolType: "standard", config: { baseUrl: "https://api.invalid/v1" }, enabled: true },
  });
  assert.deepEqual(snapshot, before);
  assert.equal(reserved, 0.05);
  assert.equal(calculateActualCost(snapshot, { requests: 1 }), 0.05);
});

test("pricing validation accepts zero and rejects incomplete or over-precise prices", () => {
  assert.doesNotThrow(() =>
    validatePricingSnapshot(pricing({ billingMode: "per_request", requestPrice: 0 })),
  );
  assert.throws(
    () => validatePricingSnapshot(pricing({ billingMode: "per_request", requestPrice: 0.1234567 })),
    (error: unknown) => error instanceof ModelPricingError && error.code === "PRICING_PRECISION_INVALID",
  );
  assert.throws(
    () => validatePricingSnapshot(pricing({ billingMode: "per_second" })),
    (error: unknown) => error instanceof ModelPricingError && error.code === "PRICING_FIELDS_INCOMPLETE",
  );
});

test("pricing targets resolve aliases and canonical Provider models", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    await db("o_agentDeploy").insert({
      id: 1,
      key: "universalAi",
      name: "通用模型",
      vendorId: "mimo",
      modelName: "mimo-v2.5",
      disabled: false,
    });
    await db("o_agentDeploy").insert({
      id: 2,
      key: "canonicalUniversalAi",
      name: "规范模型",
      vendorId: "mimo",
      modelName: "mimo:mimo-v2.5",
      disabled: false,
    });
    await migrateGenerationQueue(db);

    assert.deepEqual(await resolvePricingTarget("text", "universalAi", db), {
      providerId: "mimo",
      modelId: "mimo-v2.5",
      canonicalModel: "mimo:mimo-v2.5",
    });
    assert.deepEqual(await resolvePricingTarget("text", "canonicalUniversalAi", db), {
      providerId: "mimo",
      modelId: "mimo-v2.5",
      canonicalModel: "mimo:mimo-v2.5",
    });
    assert.deepEqual(await resolvePricingTarget("image", "grsai:gpt-image-2", db), {
      providerId: "grsai",
      modelId: "gpt-image-2",
      canonicalModel: "grsai:gpt-image-2",
    });
    await assert.rejects(
      resolvePricingTarget("video", "grsai:gpt-image-2", db),
      (error: unknown) => error instanceof ModelPricingError && error.code === "PRICING_TASK_MISMATCH",
    );
  } finally {
    await db.destroy();
  }
});

test("only Super Admin can create a validated immutable pricing version", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    await db("o_vendorConfig").insert({
      id: "aicopy",
      enable: 1,
      inputValues: JSON.stringify({ internalMarker: "must-not-enter-audit" }),
      models: JSON.stringify([
        { name: "Grok 1.5 Preview", modelName: "grok-imagine-video-1.5-preview", type: "video" },
      ]),
    });
    await migrateGenerationQueue(db);

    await assert.rejects(
      updateModelPricing(
        { id: 2, name: "group-admin", role: "admin", groupId: 10 },
        {
          providerId: "aicopy",
          modelId: "grok-imagine-video-1.5-preview",
          taskType: "video",
          billingMode: "per_second",
          secondPrice: 0.03,
          currency: "CNY",
        },
        db,
      ),
      (error: unknown) => error instanceof ModelPricingError && error.code === "SUPER_ADMIN_REQUIRED",
    );

    const updated = await updateModelPricing(
      { id: 1, name: "root", role: "super_admin", groupId: null },
      {
        providerId: "aicopy",
        modelId: "grok-imagine-video-1.5-preview",
        taskType: "video",
        billingMode: "per_second",
        secondPrice: 0.03,
        currency: "CNY",
      },
      db,
    );

    assert.equal(updated.version, 2);
    const versions = await db("o_modelPricing")
      .where({ providerId: "aicopy", modelId: "grok-imagine-video-1.5-preview" })
      .orderBy("version");
    assert.deepEqual(versions.map(({ version, status }) => ({ version, status })), [
      { version: 1, status: "superseded" },
      { version: 2, status: "active" },
    ]);
    const audit = await db("o_auditLog").where({ action: "pricing.update" }).first();
    assert.equal(audit.targetId, "aicopy:grok-imagine-video-1.5-preview");
    assert.doesNotMatch(audit.summaryJson, /internalMarker|must-not-enter-audit/i);
  } finally {
    await db.destroy();
  }
});

test("enqueue atomically reserves quota and idempotent replay does not reserve twice", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    const now = Date.now();
    const [groupId] = await db("o_group").insert({ name: "计价组", createdAt: now, updatedAt: now });
    await db("o_project").insert({ id: 1001, name: "计价项目", ownerUserId: 3, groupId });
    await migrateGenerationQueue(db);
    await db("o_quotaAccount").where({ groupId }).update({ balance: 0.2 });
    const actor = { id: 3, name: "creator", role: "creator" as const, groupId: Number(groupId) };
    const input = {
      projectId: 1001,
      handlerKey: "core.video",
      taskType: "video" as const,
      payload: {
        operation: "video",
        model: "aicopy:grok-imagine-video-1.5-preview",
        duration: 6,
      },
      idempotencyKey: "priced-video-1",
    };

    const job = await enqueueGeneration(actor, input, db);
    const replay = await enqueueGeneration(actor, input, db);
    assert.equal(replay.id, job.id);
    const account = await db("o_quotaAccount").where({ groupId }).first();
    const reservation = await db("o_quotaReservation").where({ jobId: job.id }).first();
    const storedJob = await db("o_generationJob").where({ id: job.id }).first();
    assert.equal(Number(account.reservedBalance), 0.18);
    assert.equal(Number(reservation.reservedAmount), 0.18);
    assert.equal(reservation.status, "reserved");
    assert.equal(JSON.parse(storedJob.pricingSnapshotJson).requestPrice, 0.18);
    assert.equal(await db("o_quotaReservation").count({ count: "id" }).first().then((row) => Number(row?.count)), 1);

    await assert.rejects(
      enqueueGeneration(actor, { ...input, idempotencyKey: "priced-video-2" }, db),
      (error: unknown) => error instanceof GenerationQueueError && error.code === "INSUFFICIENT_QUOTA",
    );
    assert.equal(await db("o_generationJob").count({ count: "id" }).first().then((row) => Number(row?.count)), 1);
  } finally {
    await db.destroy();
  }
});

test("queued cancellation releases its reservation exactly once", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    const now = Date.now();
    const [groupId] = await db("o_group").insert({ name: "取消组", createdAt: now, updatedAt: now });
    await db("o_project").insert({ id: 2001, name: "取消项目", ownerUserId: 8, groupId });
    await migrateGenerationQueue(db);
    await db("o_quotaAccount").where({ groupId }).update({ balance: 1 });
    const actor = { id: 8, name: "creator", role: "creator" as const, groupId: Number(groupId) };
    const job = await enqueueGeneration(actor, {
      projectId: 2001,
      handlerKey: "core.video",
      taskType: "video",
      payload: { model: "aicopy:grok-imagine-video-1.5-preview", duration: 6 },
      idempotencyKey: "cancel-priced-video",
    }, db);

    await cancelGenerationJob(actor, job.id, db);
    await cancelGenerationJob(actor, job.id, db);
    const account = await db("o_quotaAccount").where({ groupId }).first();
    const reservation = await db("o_quotaReservation").where({ jobId: job.id }).first();
    assert.equal(Number(account.reservedBalance), 0);
    assert.equal(reservation.status, "released");
    assert.equal(Number(reservation.finalAmount), 0);
  } finally {
    await db.destroy();
  }
});

test("successful priced job settles from its snapshot exactly once", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    const now = Date.now();
    const [groupId] = await db("o_group").insert({ name: "结算组", createdAt: now, updatedAt: now });
    await db("o_project").insert({ id: 3001, name: "结算项目", ownerUserId: 9, groupId });
    await migrateGenerationQueue(db);
    await db("o_quotaAccount").where({ groupId }).update({ balance: 1 });
    const actor = { id: 9, name: "creator", role: "creator" as const, groupId: Number(groupId) };
    const job = await enqueueGeneration(actor, {
      projectId: 3001,
      handlerKey: "core.video",
      taskType: "video",
      payload: { model: "aicopy:grok-imagine-video-1.5-preview", duration: 6 },
      idempotencyKey: "settle-priced-video",
    }, db);
    const metering = {
      providerId: "untrusted-provider",
      modelId: "untrusted-model",
      units: { requests: 1, seconds: 6 },
      estimatedCost: 999,
      currency: "USD",
      pricingSnapshot: {},
      providerRequestId: null,
    };

    const first = await completeGenerationUsage(job.id, { ok: true }, metering, db, now + 1);
    const replay = await completeGenerationUsage(job.id, { ok: true }, metering, db, now + 2);
    assert.equal(first.id, replay.id);
    assert.equal(first.estimatedCost, 0.18);
    const account = await db("o_quotaAccount").where({ groupId }).first();
    const reservation = await db("o_quotaReservation").where({ jobId: job.id }).first();
    const usage = await db("o_usageLedger").where({ jobId: job.id }).first();
    assert.equal(Number(account.balance), 0.82);
    assert.equal(Number(account.reservedBalance), 0);
    assert.equal(account.billingStatus, "active");
    assert.equal(reservation.status, "settled");
    assert.equal(Number(reservation.finalAmount), 0.18);
    assert.equal(usage.providerId, "aicopy");
    assert.equal(usage.modelId, "grok-imagine-video-1.5-preview");
    assert.equal(await db("o_quotaLedger").where({ usageLedgerId: usage.id }).count({ count: "id" }).first().then((row) => Number(row?.count)), 1);
  } finally {
    await db.destroy();
  }
});

test("Token overage creates debt and top-up restores the account", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    const now = Date.now();
    const [groupId] = await db("o_group").insert({ name: "Token组", createdAt: now, updatedAt: now });
    await db("o_project").insert({ id: 4001, name: "Token项目", ownerUserId: 10, groupId });
    await db("o_agentDeploy").insert({
      id: 1, key: "universalAi", name: "Token模型", vendorId: "mimo", modelName: "mimo-v2.5", disabled: false,
    });
    await migrateGenerationQueue(db);
    await db("o_modelPricing").where({ providerId: "mimo", modelId: "mimo-v2.5", status: "active" }).update({ status: "superseded" });
    await db("o_modelPricing").insert({
      providerId: "mimo", modelId: "mimo-v2.5", taskType: "text", billingMode: "per_token",
      inputPricePerMillion: 1, outputPricePerMillion: 1, fallbackRequestPrice: 0.05,
      currency: "CNY", version: 2, status: "active", effectiveAt: now, createdBy: 1, createdAt: now,
    });
    await db("o_quotaAccount").where({ groupId }).update({ balance: 0.2 });
    const actor = { id: 10, name: "creator", role: "creator" as const, groupId: Number(groupId) };
    const job = await enqueueGeneration(actor, {
      projectId: 4001, handlerKey: "core.text", taskType: "text",
      payload: { model: "universalAi" }, idempotencyKey: "token-debt-1",
    }, db);
    await completeGenerationUsage(job.id, { ok: true }, {
      providerId: "mimo", modelId: "mimo-v2.5",
      units: { requests: 1, inputTokens: 300_000, outputTokens: 0 },
      estimatedCost: null, currency: null, pricingSnapshot: {}, providerRequestId: null,
    }, db, now + 1);

    let account = await db("o_quotaAccount").where({ groupId }).first();
    assert.equal(Number(account.balance), -0.1);
    assert.equal(account.billingStatus, "debt");
    await assert.rejects(
      enqueueGeneration(actor, {
        projectId: 4001, handlerKey: "core.text", taskType: "text",
        payload: { model: "universalAi" }, idempotencyKey: "token-debt-2",
      }, db),
      (error: unknown) => error instanceof GenerationQueueError && error.code === "ACCOUNT_IN_DEBT",
    );
    await adjustQuota(
      { id: 1, name: "root", role: "super_admin", groupId: null },
      { groupId: Number(groupId), entryType: "manual_topup", amount: 0.1, reason: "清偿欠费" },
      db,
    );
    account = await db("o_quotaAccount").where({ groupId }).first();
    assert.equal(Number(account.balance), 0);
    assert.equal(account.billingStatus, "active");
  } finally {
    await db.destroy();
  }
});

test("text usage normalizes common Provider token shapes", () => {
  assert.deepEqual(normalizeTextUsage({ usage: { inputTokens: 120, outputTokens: 30 } }), {
    requests: 1, inputTokens: 120, outputTokens: 30,
  });
  assert.deepEqual(normalizeTextUsage({ usage: { promptTokens: 120, completionTokens: 30 } }), {
    requests: 1, inputTokens: 120, outputTokens: 30,
  });
  assert.deepEqual(normalizeTextUsage({ usage: { inputTokens: 120 } }), { requests: 1 });
  assert.deepEqual(normalizeTextUsage({}), { requests: 1 });
});

test("pricing administration and scoped estimate expose sanitized data", async () => {
  const db = createTestDB();
  try {
    await initDB(db, false, false);
    const now = Date.now();
    const [groupId] = await db("o_group").insert({ name: "估价组", createdAt: now, updatedAt: now });
    await db("o_agentDeploy").insert({
      id: 1, key: "universalAi", name: "通用模型", vendorId: "mimo", modelName: "mimo-v2.5", disabled: false,
    });
    await migrateGenerationQueue(db);
    await db("o_quotaAccount").where({ groupId }).update({ balance: 1, reservedBalance: 0.2 });
    await assert.rejects(
      listModelPricing({ id: 2, name: "admin", role: "admin", groupId: Number(groupId) }, db),
      (error: unknown) => error instanceof ModelPricingError && error.code === "SUPER_ADMIN_REQUIRED",
    );
    const prices = await listModelPricing({ id: 1, name: "root", role: "super_admin", groupId: null }, db);
    assert.equal(prices.length, 4);
    assert.equal(JSON.stringify(prices).includes("inputValues"), false);
    const estimate = await estimateModelPricing(
      { id: 3, name: "creator", role: "creator", groupId: Number(groupId) },
      { taskType: "text", model: "universalAi", units: { requests: 1 } },
      db,
    );
    assert.equal(estimate.estimatedCost, 0.05);
    assert.deepEqual(estimate.account, {
      groupId: Number(groupId), balance: 1, reservedBalance: 0.2, availableBalance: 0.8, billingStatus: "active",
    });
  } finally {
    await db.destroy();
  }
});
