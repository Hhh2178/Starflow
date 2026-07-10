import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
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
  getGenerationJob,
  GenerationQueueError,
  listGenerationJobs,
  reprioritizeGenerationJob,
} from "@/services/generationQueue";
import { chooseFairCandidate, claimNextJob } from "@/services/generationScheduler";
import { executeClaimedJob, recoverExpiredJobs } from "@/services/generationScheduler";
import { createGenerationJobRegistry } from "@/jobs/registry";
import { coreGenerationRegistry, createCoreGenerationRegistry } from "@/jobs/coreRegistry";
import type { GenerationExecutionContext, GenerationJobHandler } from "@/types/generationQueue";
import { createTextGenerationHandler, textGenerationPayloadSchema } from "@/jobs/handlers/textGeneration";
import { executeCoreTextGeneration } from "@/jobs/handlers/coreTextExecutor";
import { createImageGenerationHandler } from "@/jobs/handlers/imageGeneration";
import { createVideoGenerationHandler } from "@/jobs/handlers/videoGeneration";
import {
  enqueueAssetImageJob,
  enqueueNovelEventJobs,
  enqueueStoryboardImageJobs,
  enqueueVideoJobs,
  enqueueVideoPromptJobs,
} from "@/services/generationWorkflows";
import { completeGenerationUsage } from "@/services/generationUsage";
import { getQuotaOverview, QuotaManagementError } from "@/services/quotaManagement";
import { createGetJobRouter } from "@/routes/generation/getJob";
import { createGenerateVideoPromptHandler } from "@/routes/production/workbench/generateVideoPrompt";
import { createBatchGeneratePromptHandler } from "@/routes/production/workbench/batchGeneratePrompt";

const zeroUsage = { total: 0, text: 0, image: 0, video: 0 };
const defaultGroupLimit = { total: 4, text: 3, image: 2, video: 1 };
const defaultUserLimit = { total: 2, text: 2, image: 1, video: 1 };
const generationQueueOrderingIndex = "o_generationJob_queue_order_idx";
const expectedGenerationQueueOrderingIndex = [
  { name: "groupId", desc: 0 },
  { name: "status", desc: 0 },
  { name: "priority", desc: 1 },
  { name: "queuedAt", desc: 0 },
  { name: "id", desc: 0 },
];

async function getGenerationQueueOrderingIndex(db: ReturnType<typeof knex>) {
  const indexes = await db.raw("PRAGMA index_list('o_generationJob')") as Array<{ name: string }>;
  const matchingIndexes = indexes.filter((index) => index.name === generationQueueOrderingIndex);
  if (matchingIndexes.length === 0) return { count: 0, columns: [] };
  const indexColumns = await db.raw(`PRAGMA index_xinfo('${generationQueueOrderingIndex}')`) as Array<{
    seqno: number;
    name: string | null;
    desc: number;
    key: number;
  }>;
  return {
    count: matchingIndexes.length,
    columns: indexColumns
      .filter((column) => column.key === 1)
      .sort((left, right) => left.seqno - right.seqno)
      .map((column) => ({ name: column.name, desc: column.desc })),
  };
}

async function testGenerationQueueOrderingIndexMigration(db: ReturnType<typeof knex>): Promise<void> {
  if ((await getGenerationQueueOrderingIndex(db)).count > 0) {
    await db.schema.alterTable("o_generationJob", (table) => {
      table.dropIndex(["groupId", "status", "priority", "queuedAt", "id"], generationQueueOrderingIndex);
    });
  }
  assert.deepEqual(await getGenerationQueueOrderingIndex(db), { count: 0, columns: [] });
  await migrateGenerationQueue(db);
  assert.deepEqual(await getGenerationQueueOrderingIndex(db), {
    count: 1,
    columns: expectedGenerationQueueOrderingIndex,
  });
  await migrateGenerationQueue(db);
  assert.deepEqual(await getGenerationQueueOrderingIndex(db), {
    count: 1,
    columns: expectedGenerationQueueOrderingIndex,
  });
}

async function testFreshGenerationQueueOrderingIndex(): Promise<void> {
  const freshDb = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(freshDb, false, false);
    await initDB(freshDb, false, false);
    assert.deepEqual(await getGenerationQueueOrderingIndex(freshDb), {
      count: 1,
      columns: expectedGenerationQueueOrderingIndex,
    });
  } finally {
    await freshDb.destroy();
  }
}

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

function testTextGenerationPayloadContract(): void {
  assert.deepEqual(
    textGenerationPayloadSchema.parse({
      operation: "novel_events",
      projectId: 1001,
      targetId: 501,
      model: "universalAi",
      prompt: "",
    }),
    {
      operation: "novel_events",
      projectId: 1001,
      targetId: 501,
      model: "universalAi",
      prompt: "",
    },
  );
  const videoPromptPayload = {
    operation: "video_prompt" as const,
    projectId: 1001,
    targetId: 901,
    model: "universalAi" as const,
    prompt: "" as const,
    videoModel: "vendor:seedance-2.0",
    mode: "multi-reference",
    references: [
      { kind: "asset" as const, id: 601 },
      { kind: "storyboard" as const, id: 701 },
    ],
  };
  assert.deepEqual(textGenerationPayloadSchema.parse(videoPromptPayload), videoPromptPayload);

  for (const payload of [
    { ...videoPromptPayload, model: "vendor:text-model" },
    { ...videoPromptPayload, prompt: "client supplied prompt" },
    { ...videoPromptPayload, references: [{ kind: "image", id: 601 }] },
    { ...videoPromptPayload, concurrentCount: 99 },
  ]) {
    assert.throws(() => textGenerationPayloadSchema.parse(payload));
  }

  for (const operation of ["script_agent", "production_agent"] as const) {
    assert.equal(textGenerationPayloadSchema.parse({
      operation,
      projectId: 1001,
      targetId: 1,
      model: "universalAi",
      prompt: "",
    }).operation, operation);
  }
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

async function testCoreRegistryForwardsExecutionContext(): Promise<void> {
  let receivedContext: GenerationExecutionContext | undefined;
  const registry = createCoreGenerationRegistry({
    text: async (_payload, context) => {
      receivedContext = context;
      return {
        result: {},
        metering: {
          providerId: null,
          modelId: "universalAi",
          units: {},
          estimatedCost: null,
          currency: null,
          pricingSnapshot: {},
          providerRequestId: null,
        },
      };
    },
  });
  const context: GenerationExecutionContext = {
    jobId: 71,
    groupId: 101,
    ownerUserId: 3,
    projectId: 1001,
    signal: new AbortController().signal,
    heartbeat: async () => undefined,
    setProviderRequestId: async () => undefined,
  };
  const handler = registry.get("core.text")!;
  const payload = handler.parsePayload({
    operation: "novel_events",
    projectId: 1001,
    targetId: 501,
    model: "universalAi",
    prompt: "",
  });
  await handler.execute(context, payload);
  assert.equal(receivedContext, context);
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

  await db("o_project").insert({
    id: 1103,
    name: "same-group-other-project",
    ownerUserId: 3,
    groupId: 101,
    createTime: Date.now(),
  });
  await db("o_assets").insert({ id: 602, projectId: 1103, type: "role", name: "other hero" });
  await db("o_storyboard").insert({ id: 702, projectId: 1002, scriptId: 802, videoDesc: "other group shot" });
  await db("o_videoTrack").insert([
    { id: 902, projectId: 1001, scriptId: 801, state: "未生成" },
    { id: 903, projectId: 1103, scriptId: 803, state: "未生成" },
    { id: 904, projectId: 1001, scriptId: 801, state: "未生成", reason: "old error" },
    { id: 905, projectId: 1001, scriptId: 801, state: "未生成" },
  ]);
  const promptInput = {
    projectId: 1001,
    videoModel: "vendor:seedance-2.0",
    mode: "multi-reference",
    tracks: [
      { trackId: 901, references: [{ kind: "asset" as const, id: 601 }] },
      { trackId: 902, references: [{ kind: "storyboard" as const, id: 701 }] },
      { trackId: 905, references: [] },
    ],
  };
  const promptJobs = await enqueueVideoPromptJobs(creatorA, promptInput, "request-prompt-1", db);
  await db("o_videoTrack").whereIn("id", [901, 902, 905]).update({ state: "未生成", reason: "stale state" });
  const duplicatePromptJobs = await enqueueVideoPromptJobs(creatorA, promptInput, "request-prompt-1", db);
  assert.deepEqual(promptJobs.map(({ targetId, status }) => ({ targetId, status })), [
    { targetId: 901, status: "queued" },
    { targetId: 902, status: "queued" },
    { targetId: 905, status: "queued" },
  ]);
  assert.deepEqual(duplicatePromptJobs.map((item) => item.jobId), promptJobs.map((item) => item.jobId));
  const promptJobRows = await db("o_generationJob")
    .whereIn("id", promptJobs.map((item) => item.jobId))
    .orderBy("id")
    .select("idempotencyKey", "handlerKey", "taskType", "payloadJson");
  assert.deepEqual(promptJobRows.map((row) => row.idempotencyKey), [
    "video-prompt:request-prompt-1:901",
    "video-prompt:request-prompt-1:902",
    "video-prompt:request-prompt-1:905",
  ]);
  assert.equal(promptJobRows.every((row) => row.handlerKey === "core.text" && row.taskType === "text"), true);
  const promptPayloads = promptJobRows.map((row) => textGenerationPayloadSchema.parse(JSON.parse(row.payloadJson)));
  assert.deepEqual(promptPayloads, [
    {
      operation: "video_prompt",
      projectId: 1001,
      targetId: 901,
      model: "universalAi",
      prompt: "",
      videoModel: "vendor:seedance-2.0",
      mode: "multi-reference",
      references: [{ kind: "asset", id: 601 }],
    },
    {
      operation: "video_prompt",
      projectId: 1001,
      targetId: 902,
      model: "universalAi",
      prompt: "",
      videoModel: "vendor:seedance-2.0",
      mode: "multi-reference",
      references: [{ kind: "storyboard", id: 701 }],
    },
    {
      operation: "video_prompt",
      projectId: 1001,
      targetId: 905,
      model: "universalAi",
      prompt: "",
      videoModel: "vendor:seedance-2.0",
      mode: "multi-reference",
      references: [],
    },
  ]);
  assert.deepEqual(
    await db("o_videoTrack").whereIn("id", [901, 902, 905]).orderBy("id").select("id", "state", "reason"),
    [
      { id: 901, state: "生成中", reason: null },
      { id: 902, state: "生成中", reason: null },
      { id: 905, state: "生成中", reason: null },
    ],
  );

  const terminalStatuses = ["succeeded", "failed", "cancelled"] as const;
  const terminalTrackStates = ["已完成", "生成失败", "已取消"] as const;
  for (const [index, job] of promptJobs.entries()) {
    await db("o_generationJob").where({ id: job.jobId }).update({
      status: terminalStatuses[index],
      finishedAt: Date.now(),
    });
    await db("o_videoTrack").where({ id: job.targetId }).update({
      state: terminalTrackStates[index],
      reason: `terminal-${terminalStatuses[index]}`,
    });
  }
  const terminalReplays = await enqueueVideoPromptJobs(creatorA, promptInput, "request-prompt-1", db);
  assert.deepEqual(terminalReplays.map((item) => item.status), terminalStatuses);
  assert.deepEqual(
    await db("o_videoTrack").whereIn("id", [901, 902, 905]).orderBy("id").select("state", "reason"),
    terminalStatuses.map((status, index) => ({
      state: terminalTrackStates[index],
      reason: `terminal-${status}`,
    })),
  );
  await db("o_generationJob").whereIn("id", promptJobs.map((item) => item.jobId)).del();

  for (const [trackId, references] of [
    [904, [{ kind: "asset", id: 602 }]],
    [904, [{ kind: "storyboard", id: 702 }]],
    [903, []],
  ] as const) {
    await assert.rejects(
      enqueueVideoPromptJobs(creatorA, {
        projectId: 1001,
        videoModel: "vendor:seedance-2.0",
        mode: "multi-reference",
        tracks: [{ trackId, references: references.map((reference) => ({ ...reference })) }],
      }, `invalid-prompt-${trackId}-${references.length}`, db),
      (error: unknown) => error instanceof GenerationQueueError && error.status === 404,
    );
  }
  assert.equal((await db("o_videoTrack").where({ id: 904 }).first()).state, "未生成");
  assert.equal(Number((await db("o_generationJob").count({ count: "id" }).first())?.count), 0);

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

async function testCoreVideoPromptExecutor(db: ReturnType<typeof knex>): Promise<void> {
  await db("o_project").where({ id: 1001 }).update({ artStyle: "cinematic" });
  await db("o_image").insert({ id: 960, assetsId: 961, filePath: "/project/hero.png", state: "已完成" });
  await db("o_assets").insert({
    id: 961,
    projectId: 1001,
    imageId: 960,
    type: "role",
    name: "Hero",
  });
  await db("o_storyboard").insert({
    id: 962,
    projectId: 1001,
    scriptId: 801,
    prompt: "storyboard image prompt",
    videoDesc: "Hero crosses the rain-soaked street",
    track: "main",
    duration: "4",
    shouldGenerateImage: 1,
  });
  await db("o_assets2Storyboard").insert({ storyboardId: 962, assetId: 961 });
  await db("o_videoTrack").insert([
    { id: 963, projectId: 1001, scriptId: 801, state: "生成中" },
    { id: 964, projectId: 1001, scriptId: 801, state: "生成中" },
  ]);
  await db("o_modelPrompt").insert({
    id: 990,
    vendorId: "vendor",
    model: "seedance-2.0",
    path: "video/custom-seedance.md",
  });

  const readPaths: string[] = [];
  const aiCalls: Array<{ model: string; input: any }> = [];
  const providerMarkers: string[] = [];
  const executionContext: GenerationExecutionContext = {
    jobId: 77,
    groupId: 101,
    ownerUserId: 3,
    projectId: 1001,
    signal: new AbortController().signal,
    heartbeat: async () => undefined,
    setProviderRequestId: async (id) => {
      providerMarkers.push(id);
    },
  };
  const result = await executeCoreTextGeneration({
    operation: "video_prompt",
    projectId: 1001,
    targetId: 963,
    model: "universalAi",
    prompt: "",
    videoModel: "vendor:seedance-2.0",
    mode: "multi-reference",
    references: [
      { kind: "asset", id: 961 },
      { kind: "storyboard", id: 962 },
    ],
  }, executionContext, {
    connection: db,
    getPath: () => "C:\\prompt-root",
    readFile: async (filePath) => {
      readPaths.push(filePath);
      return "bound video prompt template";
    },
    getArtPrompt: (styleName, source, fileName) => {
      assert.deepEqual([styleName, source, fileName], ["cinematic", "art_skills", "art_storyboard_video"]);
      return "cinematic visual manual";
    },
    invokeText: async (model, input) => {
      assert.deepEqual(providerMarkers, ["video-prompt:77"]);
      aiCalls.push({ model, input });
      return { text: "generated video prompt" };
    },
  });
  assert.deepEqual(providerMarkers, ["video-prompt:77"]);
  assert.equal(readPaths.length, 1);
  assert.equal(readPaths[0].endsWith("custom-seedance.md"), true);
  assert.equal(aiCalls[0].model, "universalAi");
  assert.equal(aiCalls[0].input.system, "bound video prompt template");
  assert.equal(aiCalls[0].input.messages[0].content, "cinematic visual manual");
  assert.equal(aiCalls[0].input.messages[1].content.includes("Hero"), true);
  assert.equal(aiCalls[0].input.messages[1].content.includes("Hero crosses the rain-soaked street"), true);
  assert.deepEqual(result, {
    result: { trackId: 963, prompt: "generated video prompt" },
    metering: {
      providerId: null,
      modelId: "universalAi",
      units: {},
      estimatedCost: null,
      currency: null,
      pricingSnapshot: {},
      providerRequestId: null,
    },
  });
  assert.deepEqual(
    await db("o_videoTrack").where({ id: 963 }).select("state", "prompt", "reason").first(),
    { state: "已完成", prompt: "generated video prompt", reason: null },
  );

  const automaticTemplatePaths: string[] = [];
  const failedProviderMarkers: string[] = [];
  const failedExecutionContext: GenerationExecutionContext = {
    ...executionContext,
    jobId: 78,
    setProviderRequestId: async (id) => {
      failedProviderMarkers.push(id);
    },
  };
  await assert.rejects(
    executeCoreTextGeneration({
      operation: "video_prompt",
      projectId: 1001,
      targetId: 964,
      model: "universalAi",
      prompt: "",
      videoModel: "vendor:wan-2.6",
      mode: "startFrameOptional",
      references: [],
    }, failedExecutionContext, {
      connection: db,
      getPath: () => "C:\\prompt-root",
      readFile: async (filePath) => {
        automaticTemplatePaths.push(filePath);
        return "automatic wan template";
      },
      getArtPrompt: () => "cinematic visual manual",
      invokeText: async () => {
        assert.deepEqual(failedProviderMarkers, ["video-prompt:78"]);
        throw new Error("provider unavailable");
      },
    }),
    /provider unavailable/,
  );
  assert.deepEqual(failedProviderMarkers, ["video-prompt:78"]);
  assert.equal(automaticTemplatePaths.some((filePath) => filePath.endsWith("wan2.6Single-imageFirstFrameMode.md")), true);
  assert.deepEqual(
    await db("o_videoTrack").where({ id: 964 }).select("state", "reason").first(),
    { state: "生成失败", reason: "provider unavailable" },
  );
}

async function testVideoPromptRouteHandlers(): Promise<void> {
  const actor: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };
  const calls: Array<{ actor: AuthUser; input: any; requestId: string }> = [];
  const enqueue = async (requestActor: AuthUser, input: any, requestId: string) => {
    calls.push({ actor: requestActor, input, requestId });
    return input.tracks.map((track: any, index: number) => ({
      jobId: 2000 + index,
      targetId: track.trackId,
      status: "queued" as const,
    }));
  };
  const createResponse = () => {
    const response: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send(body: unknown) {
        this.body = body;
        return this;
      },
    };
    return response;
  };

  const singleResponse = createResponse();
  await createGenerateVideoPromptHandler(enqueue as any)({
    user: actor,
    headers: { "x-request-id": "route-single-request" },
    body: {
      projectId: 1001,
      trackId: 901,
      model: "vendor:seedance-2.0",
      mode: "multi-reference",
      concurrentCount: 99,
      info: [
        { id: 601, sources: "assets" },
        { id: 701, sources: "storyboard" },
      ],
    },
  } as any, singleResponse, (() => undefined) as any);
  assert.equal(singleResponse.statusCode, 200);
  assert.deepEqual(singleResponse.body, {
    code: 200,
    data: {
      jobId: 2000,
      targetId: 901,
      status: "queued",
      message: "已加入视频提示词生成队列",
    },
    message: "成功",
  });
  assert.deepEqual(calls[0], {
    actor,
    requestId: "route-single-request",
    input: {
      projectId: 1001,
      videoModel: "vendor:seedance-2.0",
      mode: "multi-reference",
      tracks: [{
        trackId: 901,
        references: [
          { kind: "asset", id: 601 },
          { kind: "storyboard", id: 701 },
        ],
      }],
    },
  });
  assert.equal("concurrentCount" in calls[0].input, false);

  const batchResponse = createResponse();
  await createBatchGeneratePromptHandler(enqueue as any)({
    user: actor,
    headers: { "x-request-id": "route-batch-request" },
    body: {
      projectId: 1001,
      model: "vendor:wan-2.6",
      mode: "startFrameOptional",
      concurrentCount: 42,
      trackData: [
        { trackId: 901, info: [{ id: 601, sources: "assets" }] },
        { trackId: 902, info: [{ id: 701, sources: "storyboard" }] },
      ],
    },
  } as any, batchResponse, (() => undefined) as any);
  assert.equal(batchResponse.statusCode, 200);
  assert.deepEqual(batchResponse.body, {
    code: 200,
    data: {
      items: [
        { jobId: 2000, targetId: 901, status: "queued" },
        { jobId: 2001, targetId: 902, status: "queued" },
      ],
      total: 2,
      message: "已加入视频提示词生成队列",
    },
    message: "成功",
  });
  assert.deepEqual(calls[1], {
    actor,
    requestId: "route-batch-request",
    input: {
      projectId: 1001,
      videoModel: "vendor:wan-2.6",
      mode: "startFrameOptional",
      tracks: [
        { trackId: 901, references: [{ kind: "asset", id: 601 }] },
        { trackId: 902, references: [{ kind: "storyboard", id: 701 }] },
      ],
    },
  });
  assert.equal("concurrentCount" in calls[1].input, false);
}

async function testGenerationJobSafetyContract(db: ReturnType<typeof knex>): Promise<void> {
  await db("o_generationJob").del();
  const creatorA: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };
  const adminA: AuthUser = { id: 2, name: "admin-a", role: "admin", groupId: 101 };
  const superAdmin: AuthUser = { id: 1, name: "root", role: "super_admin", groupId: null };
  const baseJob = {
    projectId: 1001,
    sourceTaskId: 501,
    handlerKey: "test.text",
    taskType: "text",
    status: "queued",
    priority: 10,
    payloadJson: JSON.stringify({ prompt: "must-not-leak" }),
    resultJson: JSON.stringify({ text: "safe result" }),
    errorCode: "PROVIDER_TIMEOUT",
    errorMessage: "timed out",
    leaseOwner: "worker-secret",
    providerRequestId: "provider-secret",
    queuedAt: 200,
    startedAt: null,
    finishedAt: null,
  };
  const [adminVisibleId] = await db("o_generationJob").insert({
    ...baseJob,
    groupId: 101,
    ownerUserId: 5,
    priority: 20,
    queuedAt: 300,
    idempotencyKey: "get-job-admin-visible",
  });
  const [creatorVisibleId] = await db("o_generationJob").insert({
    ...baseJob,
    groupId: 101,
    ownerUserId: 3,
    idempotencyKey: "get-job-creator-visible",
  });
  await db("o_generationJob").insert({
    ...baseJob,
    groupId: 101,
    ownerUserId: 3,
    resultJson: "{broken-json",
    idempotencyKey: "get-job-id-tiebreaker",
  });
  const [groupBJobId] = await db("o_generationJob").insert({
    ...baseJob,
    groupId: 102,
    ownerUserId: 4,
    projectId: 1002,
    priority: 100,
    queuedAt: 1,
    idempotencyKey: "get-job-other-group",
  });

  const creatorJob = await getGenerationJob(creatorA, Number(creatorVisibleId), db);
  assert.deepEqual(Object.keys(creatorJob).sort(), [
    "errorCode",
    "errorMessage",
    "finishedAt",
    "groupId",
    "handlerKey",
    "id",
    "ownerUserId",
    "priority",
    "projectId",
    "queuePosition",
    "queuedAt",
    "result",
    "sourceTaskId",
    "startedAt",
    "status",
    "taskType",
  ].sort());
  assert.deepEqual(creatorJob.result, { text: "safe result" });
  assert.equal(creatorJob.queuePosition, 2);
  assert.equal("payloadJson" in creatorJob, false);
  assert.equal("leaseOwner" in creatorJob, false);
  assert.equal("providerRequestId" in creatorJob, false);

  assert.equal((await getGenerationJob(adminA, Number(adminVisibleId), db)).ownerUserId, 5);
  assert.equal((await getGenerationJob(superAdmin, Number(groupBJobId), db)).groupId, 102);
  for (const [actor, jobId] of [
    [creatorA, adminVisibleId],
    [creatorA, groupBJobId],
    [adminA, groupBJobId],
  ] as const) {
    await assert.rejects(
      getGenerationJob(actor, Number(jobId), db),
      (error: unknown) => error instanceof GenerationQueueError && error.status === 404 && error.code === "JOB_NOT_FOUND",
    );
  }

  const malformedResultJob = await db("o_generationJob")
    .where({ idempotencyKey: "get-job-id-tiebreaker" })
    .first();
  await db("o_generationJob")
    .where({ id: malformedResultJob.id })
    .update({ status: "succeeded", finishedAt: 400 });
  const completedJob = await getGenerationJob(creatorA, Number(malformedResultJob.id), db);
  assert.equal(completedJob.result, null);
  assert.equal(completedJob.queuePosition, null);
}

async function testGetGenerationJobRouteHandler(db: ReturnType<typeof knex>): Promise<void> {
  const actors = {
    creatorA: { id: 3, name: "creator-a", role: "creator", groupId: 101 },
    adminA: { id: 2, name: "admin-a", role: "admin", groupId: 101 },
  } satisfies Record<string, AuthUser>;
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = actors[String(req.headers["x-test-actor"] ?? "creatorA") as keyof typeof actors];
    next();
  });
  app.use(
    "/api/generation/getJob",
    createGetJobRouter((actor, jobId) => getGenerationJob(actor, jobId, db)),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const routeUrl = `http://127.0.0.1:${port}/api/generation/getJob`;
    for (const query of ["", "?id=0", "?id=-1", "?id=1.5", "?id=not-a-number"]) {
      const response = await fetch(`${routeUrl}${query}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 400);
    }

    const creatorJob = await db("o_generationJob").where({ idempotencyKey: "get-job-creator-visible" }).first();
    const adminJob = await db("o_generationJob").where({ idempotencyKey: "get-job-admin-visible" }).first();
    const groupBJob = await db("o_generationJob").where({ idempotencyKey: "get-job-other-group" }).first();
    const successResponse = await fetch(`${routeUrl}?id=${creatorJob.id}`, {
      headers: { "x-test-actor": "creatorA" },
    });
    assert.equal(successResponse.status, 200);
    const successBody = await successResponse.json();
    assert.equal(successBody.code, 200);
    assert.equal(successBody.data.id, creatorJob.id);
    assert.deepEqual(successBody.data.result, { text: "safe result" });

    for (const [actor, jobId] of [
      ["creatorA", adminJob.id],
      ["creatorA", groupBJob.id],
      ["adminA", groupBJob.id],
    ] as const) {
      const response = await fetch(`${routeUrl}?id=${jobId}`, { headers: { "x-test-actor": actor } });
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.equal(body.data.code, "JOB_NOT_FOUND");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
    coreGenerationRegistry.get("core.text")!,
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
    {
      ...base,
      handlerKey: "core.text",
      status: "running",
      idempotencyKey: "recover-video-prompt-submitted",
      providerRequestId: "video-prompt:77",
      leaseExpiresAt: 99,
    },
  ]);

  const result = await recoverExpiredJobs({ connection: db, registry, now: 100 });
  assert.deepEqual(result, { requeued: 2, needsAttention: 2 });
  assert.equal((await db("o_generationJob").where({ idempotencyKey: "recover-queued" }).first()).status, "queued");
  assert.equal((await db("o_generationJob").where({ idempotencyKey: "recover-before-submit" }).first()).status, "queued");
  assert.equal((await db("o_generationJob").where({ idempotencyKey: "recover-idempotent" }).first()).status, "queued");
  const unknown = await db("o_generationJob").where({ idempotencyKey: "recover-unknown" }).first();
  assert.equal(unknown.status, "needs_attention");
  assert.equal(unknown.errorCode, "EXTERNAL_STATE_UNKNOWN");
  const submittedVideoPrompt = await db("o_generationJob")
    .where({ idempotencyKey: "recover-video-prompt-submitted" })
    .first();
  assert.equal(submittedVideoPrompt.status, "needs_attention");
  assert.equal(submittedVideoPrompt.providerRequestId, "video-prompt:77");
  assert.equal(submittedVideoPrompt.errorCode, "EXTERNAL_STATE_UNKNOWN");
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
  testTextGenerationPayloadContract();
  await testTrustedHandlerContracts();
  await testCoreRegistryForwardsExecutionContext();
  await testVideoPromptRouteHandlers();
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

    await testGenerationQueueOrderingIndexMigration(db);
    await testFreshGenerationQueueOrderingIndex();

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
    await testCoreVideoPromptExecutor(db);
    await testGenerationJobSafetyContract(db);
    await testGetGenerationJobRouteHandler(db);
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
