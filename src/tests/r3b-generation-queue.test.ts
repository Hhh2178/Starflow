import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import { migrateGenerationQueue } from "@/lib/fixDB";
import {
  ConcurrencyPolicyError,
  evaluateCapacity,
  getEffectivePolicies,
  getScopedEffectivePolicies,
  updateGroupPolicy,
  updateUserPolicy,
} from "@/services/concurrencyPolicy";
import type { AuthUser } from "@/types/auth";
import {
  cancelGenerationJob,
  enqueueGeneration,
  GenerationQueueError,
  listGenerationJobs,
  reprioritizeGenerationJob,
} from "@/services/generationQueue";
import { chooseFairCandidate, claimNextJob } from "@/services/generationScheduler";
import { executeClaimedJob, recoverExpiredJobs } from "@/services/generationScheduler";
import { createGenerationJobRegistry } from "@/jobs/registry";
import type { GenerationJobHandler } from "@/types/generationQueue";
import { createTextGenerationHandler } from "@/jobs/handlers/textGeneration";
import { createImageGenerationHandler } from "@/jobs/handlers/imageGeneration";
import { createVideoGenerationHandler } from "@/jobs/handlers/videoGeneration";
import { enqueueAssetImageJob, enqueueNovelEventJobs, enqueueStoryboardImageJobs, enqueueVideoJobs } from "@/services/generationWorkflows";
import { completeGenerationUsage } from "@/services/generationUsage";
import { getQuotaOverview, QuotaManagementError } from "@/services/quotaManagement";

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

async function testTrustedHandlerContracts(): Promise<void> {
  const calls: string[] = [];
  const metering = {
    providerId: "fake",
    modelId: "fake-model",
    units: { requests: 1 },
    estimatedCost: null,
    currency: null,
    pricingSnapshot: {},
    providerRequestId: null,
  };
  const context = {
    jobId: 1,
    groupId: 101,
    ownerUserId: 3,
    projectId: 1001,
    signal: new AbortController().signal,
    heartbeat: async () => undefined,
    setProviderRequestId: async () => undefined,
  };
  const handlers = [
    createTextGenerationHandler(async (payload) => {
      calls.push(payload.operation);
      return { result: { text: "ok" }, metering };
    }),
    createImageGenerationHandler(async (payload) => {
      calls.push(payload.operation);
      return { result: { path: "/image.jpg" }, metering };
    }),
    createVideoGenerationHandler(async (payload) => {
      calls.push(payload.operation);
      return { result: { path: "/video.mp4" }, metering };
    }),
  ];
  const payloads = [
    { operation: "novel_events", projectId: 1001, targetId: 11, model: "1:text", prompt: "text" },
    {
      operation: "asset",
      projectId: 1001,
      targetId: 12,
      model: "1:image",
      prompt: "image",
      referenceResourceIds: [],
      size: "1K",
      aspectRatio: "16:9",
    },
    {
      operation: "track",
      projectId: 1001,
      targetId: 13,
      model: "1:video",
      prompt: "video",
      referenceResourceIds: [],
      duration: 5,
      resolution: "1080p",
      aspectRatio: "16:9",
      audio: false,
    },
  ];
  for (const [index, handler] of handlers.entries()) {
    const parsed = handler.parsePayload(payloads[index]);
    await handler.execute(context, parsed as never);
    assert.throws(() => handler.parsePayload({ ...payloads[index], providerKey: "secret" }));
    assert.throws(() => handler.parsePayload({ ...payloads[index], base64: "data:image/png;base64,AAAA" }));
  }
  assert.deepEqual(calls, ["novel_events", "asset", "track"]);
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
  assert.deepEqual(await getScopedEffectivePolicies(adminA, 101, 3, db), { group: validGroupLimit, user: creatorLimit });

  await expectPolicyError(updateUserPolicy(adminA, 2, defaultUserLimit, db), 404, "USER_NOT_FOUND");
  await expectPolicyError(getScopedEffectivePolicies(adminA, 101, 2, db), 404, "USER_NOT_FOUND");
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

function testFairSelection(): void {
  const queued = [
    { id: 1, ownerUserId: 3, priority: 0, queuedAt: 1 },
    { id: 2, ownerUserId: 3, priority: 100, queuedAt: 2 },
    { id: 3, ownerUserId: 3, priority: 0, queuedAt: 3 },
    { id: 4, ownerUserId: 4, priority: 0, queuedAt: 4 },
    { id: 5, ownerUserId: 4, priority: 0, queuedAt: 5 },
  ];
  const remaining = [...queued];
  const lastStartedByUser = new Map<number, number>();
  const selected: number[] = [];
  for (let turn = 1; remaining.length > 0; turn += 1) {
    const candidate = chooseFairCandidate(remaining, lastStartedByUser);
    assert.ok(candidate);
    selected.push(candidate.id);
    remaining.splice(remaining.findIndex((item) => item.id === candidate.id), 1);
    lastStartedByUser.set(candidate.ownerUserId, turn);
  }
  assert.deepEqual(selected, [1, 4, 2, 5, 3]);
  assert.equal(
    chooseFairCandidate([{ id: 6, ownerUserId: 5, priority: 0, queuedAt: 1 }], new Map())?.id,
    6,
  );
}

async function testQueueAndAtomicClaim(db: ReturnType<typeof knex>): Promise<void> {
  const creatorA: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };
  const adminA: AuthUser = { id: 2, name: "admin-a", role: "admin", groupId: 101 };
  const superAdmin: AuthUser = { id: 1, name: "root", role: "super_admin", groupId: null };
  await db("o_project").insert({
    id: 1001,
    name: "queue-project",
    ownerUserId: 3,
    groupId: 101,
    createTime: Date.now(),
  });
  await db("o_novel").insert([
    { id: 501, projectId: 1001, chapterIndex: 1, chapterData: "chapter secret 1", eventState: -1 },
    { id: 502, projectId: 1001, chapterIndex: 2, chapterData: "chapter secret 2", eventState: -1 },
  ]);
  await db("o_project").insert({
    id: 1002,
    name: "other-project",
    ownerUserId: 4,
    groupId: 102,
    createTime: Date.now(),
  });
  await updateGroupPolicy(
    { id: 1, name: "root", role: "super_admin", groupId: null },
    101,
    { total: 1, text: 1, image: 1, video: 1 },
    db,
  );
  await db("o_concurrencyPolicy")
    .where({ scopeType: "user", scopeId: 3 })
    .update({ totalLimit: 1, textLimit: 1, imageLimit: 1, videoLimit: 1 });

  const workflowJobs = await enqueueNovelEventJobs(creatorA, 1001, [501, 502], "request-1", db);
  assert.deepEqual(workflowJobs.map((item) => ({ targetId: item.targetId, status: item.status })), [
    { targetId: 501, status: "queued" },
    { targetId: 502, status: "queued" },
  ]);
  const workflowPayloads = await db("o_generationJob").whereIn("id", workflowJobs.map((item) => item.jobId)).select("payloadJson");
  assert.equal(workflowPayloads.every((row) => !row.payloadJson.includes("chapter secret")), true);
  assert.equal(Number((await db("o_novel").where({ eventState: 0 }).count({ count: "id" }).first())?.count), 2);
  await db("o_generationJob").whereIn("id", workflowJobs.map((item) => item.jobId)).del();

  await db("o_assets").insert({ id: 601, projectId: 1001, type: "role", name: "hero", prompt: "red coat" });
  const imageJob = await enqueueAssetImageJob(
    creatorA,
    {
      projectId: 1001,
      assetId: 601,
      model: "1:image-model",
      size: "1K",
      referenceResourceIds: [],
    },
    "request-image-1",
    db,
  );
  assert.deepEqual({ targetId: imageJob.targetId, status: imageJob.status }, { targetId: 601, status: "queued" });
  const imagePayload = JSON.parse((await db("o_generationJob").where({ id: imageJob.jobId }).first()).payloadJson);
  assert.equal(imagePayload.operation, "asset");
  assert.equal(imagePayload.targetId, imageJob.imageId);
  assert.equal("base64" in imagePayload, false);
  assert.equal((await db("o_image").where({ id: imageJob.imageId }).first()).state, "生成中");
  await db("o_generationJob").where({ id: imageJob.jobId }).del();

  await db("o_project").where({ id: 1001 }).update({ imageModel: "1:image-model", imageQuality: "1K", videoRatio: "16:9" });
  await db("o_storyboard").insert({ id: 701, projectId: 1001, scriptId: 801, prompt: "wide shot", shouldGenerateImage: 1 });
  const storyboardJobs = await enqueueStoryboardImageJobs(
    creatorA,
    { projectId: 1001, scriptId: 801, storyboardIds: [701], compulsory: false },
    "request-storyboard-1",
    db,
  );
  assert.deepEqual(storyboardJobs.map((item) => ({ targetId: item.targetId, status: item.status })), [
    { targetId: 701, status: "queued" },
  ]);
  const storyboardPayload = JSON.parse((await db("o_generationJob").where({ id: storyboardJobs[0].jobId }).first()).payloadJson);
  assert.deepEqual(
    { operation: storyboardPayload.operation, targetId: storyboardPayload.targetId, referenceResourceIds: storyboardPayload.referenceResourceIds },
    { operation: "storyboard", targetId: 701, referenceResourceIds: [] },
  );
  await db("o_generationJob").where({ id: storyboardJobs[0].jobId }).del();

  await db("o_videoTrack").insert({ id: 901, projectId: 1001, scriptId: 801, prompt: "camera move", duration: 5 });
  const videoJobs = await enqueueVideoJobs(
    creatorA,
    {
      projectId: 1001,
      scriptId: 801,
      model: "1:video-model",
      mode: "text",
      resolution: "1080p",
      audio: false,
      tracks: [{ trackId: 901, prompt: "camera move", duration: 5, references: [] }],
    },
    "request-video-1",
    db,
  );
  assert.equal(videoJobs[0].status, "queued");
  const videoPayload = JSON.parse((await db("o_generationJob").where({ id: videoJobs[0].jobId }).first()).payloadJson);
  assert.deepEqual(
    { operation: videoPayload.operation, targetId: videoPayload.targetId, referenceResources: videoPayload.referenceResources },
    { operation: "track", targetId: videoJobs[0].videoId, referenceResources: [] },
  );
  await db("o_generationJob").where({ id: videoJobs[0].jobId }).del();

  for (const payload of [
    { providerKey: "secret" },
    { imageBase64: "AAAA" },
    { executableCode: "return process.env" },
  ]) {
    await assert.rejects(
      enqueueGeneration(
        creatorA,
        {
          projectId: 1001,
          handlerKey: "test.text",
          taskType: "text",
          payload,
          idempotencyKey: `unsafe-${Object.keys(payload)[0]}`,
        },
        db,
      ),
      (error: unknown) => error instanceof GenerationQueueError && error.code === "UNSAFE_PAYLOAD",
    );
  }
  assert.equal(Number((await db("o_generationJob").count({ count: "id" }).first())?.count), 0);

  await assert.rejects(
    enqueueGeneration(
      creatorA,
      {
        projectId: 1002,
        handlerKey: "test.text",
        taskType: "text",
        payload: {},
        idempotencyKey: "cross-group",
      },
      db,
    ),
    (error: unknown) => error instanceof GenerationQueueError && error.status === 404,
  );

  const first = await enqueueGeneration(
    creatorA,
    {
      projectId: 1001,
      handlerKey: "test.text",
      taskType: "text",
      payload: { prompt: "first" },
      idempotencyKey: "atomic-first",
    },
    db,
  );
  const duplicate = await enqueueGeneration(
    creatorA,
    {
      projectId: 1001,
      handlerKey: "test.text",
      taskType: "text",
      payload: { prompt: "first" },
      idempotencyKey: "atomic-first",
    },
    db,
  );
  assert.equal(duplicate.id, first.id);
  await enqueueGeneration(
    creatorA,
    {
      projectId: 1001,
      handlerKey: "test.text",
      taskType: "text",
      payload: { prompt: "second" },
      idempotencyKey: "atomic-second",
    },
    db,
  );

  const claims = await Promise.all([
    claimNextJob(101, { connection: db, leaseOwner: "worker-a", now: 10_000 }),
    claimNextJob(101, { connection: db, leaseOwner: "worker-b", now: 10_001 }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(
    Number((await db("o_generationJob").where({ status: "running" }).count({ count: "id" }).first())?.count),
    1,
  );

  const running = claims.find((job) => job !== null)!;
  const runningAfterCancel = await cancelGenerationJob(creatorA, running.id, db);
  assert.equal(runningAfterCancel.status, "running");
  assert.notEqual((await db("o_generationJob").where({ id: running.id }).first()).cancellationRequestedAt, null);

  const queued = await db("o_generationJob").where({ status: "queued" }).first();
  const cancelled = await cancelGenerationJob(adminA, Number(queued.id), db);
  assert.equal(cancelled.status, "cancelled");
  assert.notEqual(cancelled.finishedAt, null);

  const priorityJob = await enqueueGeneration(
    creatorA,
    {
      projectId: 1001,
      handlerKey: "test.image",
      taskType: "image",
      payload: {},
      idempotencyKey: "priority-job",
    },
    db,
  );
  await assert.rejects(
    reprioritizeGenerationJob(adminA, priorityJob.id, 20, "紧急交付", db),
    (error: unknown) => error instanceof GenerationQueueError && error.status === 403,
  );
  const reprioritized = await reprioritizeGenerationJob(superAdmin, priorityJob.id, 20, "紧急交付", db);
  assert.equal(reprioritized.priority, 20);
  assert.equal(
    await db("o_auditLog").where({ action: "queue.reprioritize", targetId: String(priorityJob.id) }).first().then(Boolean),
    true,
  );

  await db("o_generationJob").del();
  await db("o_user").insert({ id: 5, name: "creator-a2", role: "creator", status: "enabled", groupId: 101 });
  await db("o_concurrencyPolicy").insert({
    scopeType: "user",
    scopeId: 5,
    totalLimit: 1,
    textLimit: 1,
    imageLimit: 1,
    videoLimit: 1,
    updatedBy: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  await db("o_project").insert({
    id: 1003,
    name: "queue-project-a2",
    ownerUserId: 5,
    groupId: 101,
    createTime: Date.now(),
  });
  const creatorA2: AuthUser = { id: 5, name: "creator-a2", role: "creator", groupId: 101 };
  const creatorB: AuthUser = { id: 4, name: "creator-b", role: "creator", groupId: 102 };
  const fairJobs = [];
  for (const [actor, projectId, key] of [
    [creatorA, 1001, "fair-a1"],
    [creatorA, 1001, "fair-a2"],
    [creatorA, 1001, "fair-a3"],
    [creatorA2, 1003, "fair-b1"],
    [creatorA2, 1003, "fair-b2"],
  ] as const) {
    fairJobs.push(await enqueueGeneration(
      actor,
      { projectId, handlerKey: "test.text", taskType: "text", payload: {}, idempotencyKey: key },
      db,
    ));
  }
  for (const [index, job] of fairJobs.entries()) {
    await db("o_generationJob").where({ id: job.id }).update({ queuedAt: index + 1 });
  }
  await db("o_generationJob").where({ id: fairJobs[1].id }).update({ priority: 100 });
  await enqueueGeneration(
    creatorB,
    { projectId: 1002, handlerKey: "test.text", taskType: "text", payload: {}, idempotencyKey: "fair-c1" },
    db,
  );

  const selectedIds: number[] = [];
  const a1 = await claimNextJob(101, { connection: db, leaseOwner: "fair-a", now: 20_000 });
  assert.ok(a1);
  selectedIds.push(a1.id);
  const c1 = await claimNextJob(102, { connection: db, leaseOwner: "fair-c", now: 20_000 });
  assert.ok(c1);
  assert.equal(c1.ownerUserId, 4);
  await db("o_generationJob").whereIn("id", [a1.id, c1.id]).update({ status: "succeeded", finishedAt: 20_001 });

  for (let turn = 1; turn < fairJobs.length; turn += 1) {
    const claimed = await claimNextJob(101, { connection: db, leaseOwner: "fair-a", now: 20_001 + turn });
    assert.ok(claimed);
    selectedIds.push(claimed.id);
    await db("o_generationJob").where({ id: claimed.id }).update({ status: "succeeded", finishedAt: 20_001 + turn });
  }
  assert.deepEqual(selectedIds, [fairJobs[0].id, fairJobs[3].id, fairJobs[1].id, fairJobs[4].id, fairJobs[2].id]);

  await db("o_generationJob").del();
  await db("o_concurrencyPolicy")
    .where({ scopeType: "group", scopeId: 101 })
    .update({ totalLimit: 2, textLimit: 2, imageLimit: 2, videoLimit: 1 });
  await db("o_concurrencyPolicy")
    .where({ scopeType: "user", scopeId: 3 })
    .update({ totalLimit: 2, textLimit: 1, imageLimit: 1, videoLimit: 1 });
  const runningText = await enqueueGeneration(
    creatorA,
    { projectId: 1001, handlerKey: "test.text", taskType: "text", payload: {}, idempotencyKey: "fifo-running" },
    db,
  );
  await db("o_generationJob").where({ id: runningText.id }).update({ status: "running", startedAt: 30_000 });
  const blockedHead = await enqueueGeneration(
    creatorA,
    { projectId: 1001, handlerKey: "test.text", taskType: "text", payload: {}, idempotencyKey: "fifo-head" },
    db,
  );
  const laterImage = await enqueueGeneration(
    creatorA,
    { projectId: 1001, handlerKey: "test.image", taskType: "image", payload: {}, idempotencyKey: "fifo-later" },
    db,
  );
  await db("o_generationJob").where({ id: blockedHead.id }).update({ queuedAt: 1 });
  await db("o_generationJob").where({ id: laterImage.id }).update({ queuedAt: 2 });
  assert.equal(await claimNextJob(101, { connection: db, leaseOwner: "fifo", now: 30_001 }), null);
}

async function testExpiredLeaseRecovery(db: ReturnType<typeof knex>): Promise<void> {
  await db("o_generationJob").del();
  const handler = (key: string, canRetryAfterProviderSubmission: boolean): GenerationJobHandler => ({
    key,
    taskType: "text",
    canRetryAfterProviderSubmission,
    parsePayload: (value) => value,
    execute: async () => ({
      result: {},
      metering: {
        providerId: null,
        modelId: null,
        units: {},
        estimatedCost: null,
        currency: null,
        pricingSnapshot: {},
        providerRequestId: null,
      },
    }),
  });
  const registry = createGenerationJobRegistry([
    handler("test.idempotent", true),
    handler("test.non-idempotent", false),
  ]);
  const base = {
    groupId: 101,
    ownerUserId: 3,
    projectId: 1001,
    taskType: "text",
    priority: 0,
    payloadJson: "{}",
    queuedAt: 1,
    attemptCount: 1,
  };
  await db("o_generationJob").insert([
    { ...base, handlerKey: "test.idempotent", status: "queued", idempotencyKey: "recover-queued" },
    {
      ...base,
      handlerKey: "test.non-idempotent",
      status: "running",
      idempotencyKey: "recover-before-submit",
      leaseExpiresAt: 99,
    },
    {
      ...base,
      handlerKey: "test.idempotent",
      status: "running",
      idempotencyKey: "recover-idempotent",
      providerRequestId: "provider-1",
      leaseExpiresAt: 99,
    },
    {
      ...base,
      handlerKey: "test.non-idempotent",
      status: "running",
      idempotencyKey: "recover-unknown",
      providerRequestId: "provider-2",
      leaseExpiresAt: 99,
    },
  ]);

  const result = await recoverExpiredJobs({ connection: db, registry, now: 100 });
  assert.deepEqual(result, { requeued: 2, needsAttention: 1 });
  assert.equal((await db("o_generationJob").where({ idempotencyKey: "recover-queued" }).first()).status, "queued");
  assert.equal((await db("o_generationJob").where({ idempotencyKey: "recover-before-submit" }).first()).status, "queued");
  assert.equal((await db("o_generationJob").where({ idempotencyKey: "recover-idempotent" }).first()).status, "queued");
  const unknown = await db("o_generationJob").where({ idempotencyKey: "recover-unknown" }).first();
  assert.equal(unknown.status, "needs_attention");
  assert.equal(unknown.errorCode, "EXTERNAL_STATE_UNKNOWN");
}

async function testWorkerLifecycle(db: ReturnType<typeof knex>): Promise<void> {
  await db("o_generationJob").del();
  let executedOutsideTransaction = false;
  const workerHandler: GenerationJobHandler<{ value: number }, { doubled: number }> = {
    key: "test.worker",
    taskType: "text",
    canRetryAfterProviderSubmission: false,
    parsePayload: (value) => value as { value: number },
    execute: async (context, payload) => {
      executedOutsideTransaction = !(db as any).isTransaction;
      await context.setProviderRequestId("provider-worker-1");
      await context.heartbeat();
      return {
        result: { doubled: payload.value * 2 },
        metering: {
          providerId: "fake",
          modelId: "fake-text",
          units: { requests: 1 },
          estimatedCost: null,
          currency: null,
          pricingSnapshot: {},
          providerRequestId: "provider-worker-1",
        },
      };
    },
  };
  const registry = createGenerationJobRegistry([workerHandler as GenerationJobHandler]);
  const [jobId] = await db("o_generationJob").insert({
    groupId: 101,
    ownerUserId: 3,
    projectId: 1001,
    handlerKey: "test.worker",
    taskType: "text",
    status: "running",
    priority: 0,
    payloadJson: JSON.stringify({ value: 4 }),
    idempotencyKey: "worker-lifecycle",
    queuedAt: 1,
    startedAt: 100,
    leaseOwner: "worker-test",
    leaseExpiresAt: 200,
  });
  await executeClaimedJob(Number(jobId), { connection: db, registry, heartbeatIntervalMs: 0, now: () => 150 });
  const completed = await db("o_generationJob").where({ id: jobId }).first();
  assert.equal(executedOutsideTransaction, true);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.providerRequestId, "provider-worker-1");
  assert.deepEqual(JSON.parse(completed.resultJson), { doubled: 8 });
  assert.equal(completed.leaseOwner, null);
  assert.equal(Number((await db("o_usageLedger").where({ jobId }).count({ count: "id" }).first())?.count), 1);
}

async function testUsageAndQuotaLedger(db: ReturnType<typeof knex>): Promise<void> {
  await db("o_generationJob").del();
  await db("o_usageLedger").del();
  await db("o_quotaLedger").del();
  await db("o_quotaAccount").where({ groupId: 101 }).update({ balance: 100 });
  const baseJob = {
    groupId: 101,
    ownerUserId: 3,
    projectId: 1001,
    handlerKey: "test.usage",
    taskType: "image",
    status: "running",
    priority: 0,
    payloadJson: "{}",
    queuedAt: 1,
    attemptCount: 1,
  };
  const [knownJobId] = await db("o_generationJob").insert({ ...baseJob, idempotencyKey: "usage-known" });
  const [unknownJobId] = await db("o_generationJob").insert({ ...baseJob, idempotencyKey: "usage-unknown" });
  const knownMetering = {
    providerId: "vendor-1",
    modelId: "image-1",
    units: { images: 1 },
    estimatedCost: 12.5,
    currency: "CNY",
    pricingSnapshot: { image: 12.5 },
    providerRequestId: "provider-known",
  };
  const knownUsage = await completeGenerationUsage(Number(knownJobId), { ok: true }, knownMetering, db, 500);
  await completeGenerationUsage(Number(knownJobId), { ok: true }, knownMetering, db, 501);
  const unknownUsage = await completeGenerationUsage(Number(unknownJobId), { ok: true }, {
    ...knownMetering,
    estimatedCost: null,
    currency: null,
    providerRequestId: null,
  }, db, 502);
  assert.equal(Number((await db("o_usageLedger").where({ jobId: knownJobId }).count({ count: "id" }).first())?.count), 1);
  assert.equal(Number((await db("o_quotaLedger").where({ usageLedgerId: knownUsage.id }).count({ count: "id" }).first())?.count), 1);
  assert.equal(Number((await db("o_quotaAccount").where({ groupId: 101 }).first()).balance), 87.5);
  assert.equal(unknownUsage.estimatedCost, null);
  assert.equal(Number((await db("o_quotaLedger").where({ usageLedgerId: unknownUsage.id }).count({ count: "id" }).first())?.count), 0);

  await db("o_generationJob").insert({
    ...baseJob,
    groupId: 102,
    ownerUserId: 4,
    projectId: 1002,
    status: "queued",
    idempotencyKey: "other-group-list",
  });
  const adminList = await listGenerationJobs({ id: 2, name: "admin-a", role: "admin", groupId: 101 }, {}, db);
  assert.equal(adminList.items.every((item) => item.groupId === 101), true);
  assert.equal(adminList.items.every((item) => !("payloadJson" in item)), true);
  const superList = await listGenerationJobs({ id: 1, name: "root", role: "super_admin", groupId: null }, {}, db);
  assert.equal(superList.items.some((item) => item.groupId === 102), true);
  const quotaOverview = await getQuotaOverview({ id: 1, name: "root", role: "super_admin", groupId: null }, db);
  const groupQuota = quotaOverview.groups.find((group) => group.groupId === 101)!;
  assert.equal(groupQuota.balance, 87.5);
  assert.equal(groupQuota.totalRecharge, 0);
  assert.equal(groupQuota.totalUsage, 12.5);
  assert.equal(quotaOverview.logs.some((log) => log.usageLedgerId === knownUsage.id), true);
  await assert.rejects(
    getQuotaOverview({ id: 2, name: "admin-a", role: "admin", groupId: 101 }, db),
    (error: unknown) => error instanceof QuotaManagementError && error.status === 403,
  );
}

async function main(): Promise<void> {
  testCapacityEvaluation();
  testFairSelection();
  await testTrustedHandlerContracts();
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
    await testQueueAndAtomicClaim(db);
    await testExpiredLeaseRecovery(db);
    await testWorkerLifecycle(db);
    await testUsageAndQuotaLedger(db);
    await db("o_concurrencyPolicy").where({ scopeType: "group", scopeId: 101 }).update({ totalLimit: 7 });
    await migrateGenerationQueue(db);
    assert.equal((await db("o_concurrencyPolicy").where({ scopeType: "group", scopeId: 101 }).first()).totalLimit, 7);
    assert.equal(await db("o_concurrencyPolicy").count({ count: "id" }).first().then((row) => Number(row?.count)), 6);
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
