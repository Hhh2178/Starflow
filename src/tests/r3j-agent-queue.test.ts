import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import type { AuthUser } from "@/types/auth";
import {
  appendAgentJobEvent,
  enqueueAgentChatJob,
  executeQueuedAgent,
  listAgentJobEvents,
  listScopedAgentJobEvents,
  PersistentAgentEventSocket,
} from "@/services/agentQueue";
import { cancelGenerationJob, GenerationQueueError } from "@/services/generationQueue";

async function main() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, false);
    assert.equal(await db.schema.hasTable("o_agentJobEvent"), true);
    const now = Date.now();
    await db("o_group").insert({ id: 101, name: "A组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now });
    await db("o_user").insert({ id: 3, name: "creator-a", role: "creator", status: "enabled", groupId: 101 });
    await db("o_project").insert({ id: 1001, name: "project", ownerUserId: 3, groupId: 101, imageModel: "vendor:image", imageQuality: "2K", videoRatio: "16:9" });
    await db("o_script").insert({ id: 801, projectId: 1001, name: "episode", content: "content" });
    await db("o_agentWorkData").insert({ id: 901, projectId: 1001, episodesId: 801, key: "scriptAgent", data: JSON.stringify({ storySkeleton: "骨架", adaptationStrategy: "策略" }) });
    await db("o_assets").insert([
      { id: 600, projectId: 1001, name: "角色", type: "role", prompt: "base portrait" },
      { id: 601, projectId: 1001, name: "衍生角色", type: "role", prompt: "portrait", assetsId: 600 },
      { id: 602, projectId: 1001, name: "其他剧本角色", type: "role", prompt: "unrelated portrait" },
    ]);
    await db("o_scriptAssets").insert([{ scriptId: 801, assetId: 600 }, { scriptId: 801, assetId: 601 }]);
    await db("o_storyboard").insert({ id: 701, projectId: 1001, scriptId: 801, prompt: "wide shot", shouldGenerateImage: 1, state: "未生成" });
    const actor: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };

    const scriptJob = await enqueueAgentChatJob(actor, {
      agentType: "script_agent",
      projectId: 1001,
      prompt: "生成故事骨架",
      isolationKey: "1001:scriptAgent",
      thinkLevel: 2,
    }, "script-request", db);
    const productionJob = await enqueueAgentChatJob(actor, {
      agentType: "production_agent",
      projectId: 1001,
      scriptId: 801,
      prompt: "生成分镜",
      isolationKey: "1001:productionAgent:801",
      thinkLevel: 1,
    }, "production-request", db);
    assert.deepEqual(
      [scriptJob, productionJob].map((item) => ({ targetId: item.targetId, status: item.status })),
      [{ targetId: 1001, status: "queued" }, { targetId: 801, status: "queued" }],
    );
    const rows = await db("o_generationJob").whereIn("id", [scriptJob.jobId, productionJob.jobId]).orderBy("id");
    const payloads = rows.map((row) => JSON.parse(row.payloadJson));
    assert.deepEqual(payloads.map((payload) => payload.operation), ["script_agent", "production_agent"]);
    assert.equal(payloads.every((payload) => typeof payload.prompt === "string" && !("socket" in payload)), true);

    await appendAgentJobEvent(scriptJob.jobId, "message", { id: "m1", role: "assistant" }, db, 100);
    await appendAgentJobEvent(scriptJob.jobId, "content:add", { messageId: "m1", content: { id: "c1" } }, db, 101);
    assert.deepEqual(await listAgentJobEvents(scriptJob.jobId, 0, db), [
      { sequence: 1, event: "message", data: { id: "m1", role: "assistant" }, createdAt: 100 },
      { sequence: 2, event: "content:add", data: { messageId: "m1", content: { id: "c1" } }, createdAt: 101 },
    ]);
    assert.deepEqual((await listAgentJobEvents(scriptJob.jobId, 1, db)).map((event) => event.sequence), [2]);

    const executed = await executeQueuedAgent(payloads[0], {
      jobId: scriptJob.jobId,
      groupId: 101,
      ownerUserId: 3,
      projectId: 1001,
      signal: new AbortController().signal,
      heartbeat: async () => undefined,
      setProviderRequestId: async () => undefined,
    }, {
      connection: db,
      runScriptAgent: async (runtime) => {
        runtime.socket.emit("message", { id: "m2", role: "assistant", status: "pending", content: [] });
        runtime.socket.emit("content:add", { messageId: "m2", content: { id: "c2", type: "text", data: "完成" } });
        runtime.socket.emit("message:update", { id: "m2", status: "complete" });
      },
    });
    assert.equal(executed.result.agentType, "script_agent");
    assert.equal(executed.result.eventCount, 3);
    const replay = await listAgentJobEvents(scriptJob.jobId, 2, db);
    assert.deepEqual(replay.map((event) => event.event), ["message", "content:add", "message:update"]);

    let planResult: any;
    const callbackSocket = new PersistentAgentEventSocket(scriptJob.jobId, db, {
      actor,
      projectId: 1001,
      requestId: "script-callback",
    });
    callbackSocket.emit("getPlanData", { key: "storySkeleton" }, (result: unknown) => { planResult = result; });
    await callbackSocket.flush();
    assert.equal(planResult.storySkeleton, "骨架");

    let flowResult: any;
    const productionSocket = new PersistentAgentEventSocket(productionJob.jobId, db, {
      actor,
      projectId: 1001,
      scriptId: 801,
      requestId: "production-callback",
    });
    productionSocket.emit("getFlowData", { key: "script" }, (result: unknown) => { flowResult = result; });
    await productionSocket.flush();
    assert.equal(flowResult.script, "content");
    assert.deepEqual(flowResult.assets.map((asset: any) => asset.id), [600]);
    assert.deepEqual(flowResult.assets[0].derive.map((asset: any) => asset.id), [601]);

    let addedAsset: any;
    productionSocket.emit("addDeriveAsset", { assetsId: 600, id: null, name: "新造型", desc: "雨衣" }, (result: unknown) => { addedAsset = result; });
    await productionSocket.flush();
    assert.equal((await db("o_assets").where({ id: addedAsset.id, projectId: 1001, assetsId: 600 }).first()).name, "新造型");
    let deletedAsset: any;
    productionSocket.emit("delDeriveAsset", { assetsId: 600, id: addedAsset.id }, (result: unknown) => { deletedAsset = result; });
    await productionSocket.flush();
    assert.deepEqual(deletedAsset, { id: addedAsset.id });
    assert.equal(await db("o_assets").where({ id: addedAsset.id }).first(), undefined);

    let addedStoryboard: any;
    productionSocket.emit("addStoryboard", { videoDesc: "雨夜街道", prompt: "rainy street", track: "main", duration: 4, associateAssetsIds: [600], shouldGenerateImage: "true" }, (result: unknown) => { addedStoryboard = result; });
    await productionSocket.flush();
    assert.equal((await db("o_storyboard").where({ id: addedStoryboard.id, projectId: 1001, scriptId: 801 }).first()).videoDesc, "雨夜街道");

    let deriveGeneration: any;
    productionSocket.emit("generateDeriveAsset", { ids: [601] }, (result: unknown) => { deriveGeneration = result; });
    await productionSocket.flush();
    assert.equal(deriveGeneration[0].status, "queued");

    let storyboardResult: any;
    productionSocket.emit("generateStoryboard", { ids: [701] }, (result: unknown) => { storyboardResult = result; });
    await productionSocket.flush();
    assert.equal(storyboardResult[0].status, "queued");
    const storyboardPayload = JSON.parse((await db("o_generationJob").where({ id: storyboardResult[0].jobId }).first()).payloadJson);
    assert.equal(storyboardPayload.targetId, 701);
    assert.equal("prompt" in JSON.parse((await db("o_generationJob").where({ id: productionJob.jobId }).first()).payloadJson), true);
    assert.equal(JSON.stringify(JSON.parse((await db("o_generationJob").where({ id: productionJob.jobId }).first()).payloadJson)).includes("portrait"), false);

    await assert.rejects(
      () => listScopedAgentJobEvents({ id: 4, name: "creator-b", role: "creator", groupId: 101 }, { jobId: scriptJob.jobId, projectId: 1001 }, db),
      (error: unknown) => error instanceof GenerationQueueError && error.status === 404,
    );
    await assert.rejects(
      () => listScopedAgentJobEvents(actor, { jobId: productionJob.jobId, projectId: 1001, scriptId: 999 }, db),
      (error: unknown) => error instanceof GenerationQueueError && error.status === 404,
    );
    assert.deepEqual((await listScopedAgentJobEvents(actor, { jobId: productionJob.jobId, projectId: 1001, scriptId: 801, afterSequence: 0 }, db)).map((event) => event.sequence), []);

    const cancelled = await cancelGenerationJob(actor, scriptJob.jobId, db);
    assert.equal(cancelled.status, "cancelled");

    const concurrentJob = scriptJob.jobId;
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendAgentJobEvent(concurrentJob, "parallel", { index }, db, 200 + index)));
    const parallelEvents = (await listAgentJobEvents(concurrentJob, 0, db)).filter((event) => event.event === "parallel");
    assert.deepEqual(parallelEvents.map((event) => event.sequence), Array.from({ length: 12 }, (_, index) => index + 6));
  } finally {
    await db.destroy();
  }
}

main().then(
  () => { console.log("R3J agent queue tests passed"); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);
