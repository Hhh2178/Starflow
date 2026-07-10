import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import knex from "knex";
import initDB from "@/lib/initDB";
import type { AuthUser } from "@/types/auth";
import type { GenerationExecutionContext } from "@/types/generationQueue";
import { executeCoreImageGeneration } from "@/jobs/handlers/coreImageExecutor";
import {
  addNovelAndEnqueueEventJobs,
  enqueueAssetImageJobs,
  enqueueEditImageJob,
} from "@/services/generationWorkflows";
import { createBatchGenerateAssetsImageRouter } from "@/routes/production/assets/batchGenerateAssetsImage";
import { createGenerateFlowImageRouter } from "@/routes/production/editImage/generateFlowImage";
import { createAddNovelRouter } from "@/routes/novel/addNovel";

const actor: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };

async function main() {
  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, false);
    const now = Date.now();
    await db("o_group").insert({ id: 101, name: "A组", creatorLimit: 5, status: "enabled", createdAt: now, updatedAt: now });
    await db("o_user").insert({ ...actor, status: "enabled", createdAt: now, updatedAt: now });
    await db("o_project").insert({ id: 1001, name: "项目一", projectType: "series", imageModel: "vendor:image", imageQuality: "2K", artStyle: "cinematic", ownerUserId: 3, groupId: 101, createTime: now });
    await db("o_assets").insert([
      { id: 601, projectId: 1001, name: "角色甲", type: "role", prompt: "hero" },
      { id: 602, projectId: 1001, name: "场景甲", type: "scene", prompt: "city" },
    ]);

    const assetItems = await enqueueAssetImageJobs(actor, { projectId: 1001, assetIds: [601, 602] }, "asset-request", db);
    assert.equal(assetItems.length, 2);
    assert.equal(assetItems.every((item) => item.status === "queued"), true);
    assert.equal(await db("o_generationJob").where({ taskType: "image" }).count({ count: "id" }).first().then((row) => Number(row?.count)), 2);

    const novelInput = { projectId: 1001, data: [{ index: 1, reel: "第一卷", chapter: "第一章", chapterData: "章节内容" }, { index: 2, reel: "第一卷", chapter: "第二章", chapterData: "章节内容二" }] };
    const firstNovel = await addNovelAndEnqueueEventJobs(actor, novelInput, "novel-request", db);
    const replayedNovel = await addNovelAndEnqueueEventJobs(actor, novelInput, "novel-request", db);
    assert.deepEqual(replayedNovel, firstNovel);
    assert.equal(firstNovel.items.length, 2);
    assert.equal(await db("o_novel").where({ projectId: 1001 }).count({ count: "id" }).first().then((row) => Number(row?.count)), 2);

    const editItem = await enqueueEditImageJob(actor, { projectId: 1001, model: "vendor:image", prompt: "编辑图片", referencePaths: ["/1001/imageFlow/source.png"], size: "2K", aspectRatio: "16:9" }, "edit-request", db);
    assert.equal(editItem.status, "queued");
    const editJob = await db("o_generationJob").where({ id: editItem.jobId }).first();
    assert.deepEqual(JSON.parse(editJob.payloadJson).referencePaths, ["/1001/imageFlow/source.png"]);
    assert.equal(editJob.payloadJson.includes("base64"), false);

    const providerMarkers: string[] = [];
    const calls: unknown[] = [];
    const context: GenerationExecutionContext = { jobId: editItem.jobId, groupId: 101, ownerUserId: 3, projectId: 1001, signal: new AbortController().signal, heartbeat: async () => undefined, setProviderRequestId: async (id) => { providerMarkers.push(id); } };
    const execution = await executeCoreImageGeneration(JSON.parse(editJob.payloadJson), context, {
      connection: db,
      getImageBase64: async (path) => `base64:${path}`,
      runImage: async (model, input) => { calls.push({ model, input }); return { save: async (path) => { calls.push({ save: path }); } }; },
      getSmallImageUrl: async (path) => `/oss/small${path}`,
      createId: () => "fixed",
    });
    assert.deepEqual(providerMarkers, [`image:${editItem.jobId}`]);
    assert.equal(calls.length, 2);
    assert.deepEqual(execution.result, { imageId: 1001, path: "/oss/small/1001/workFlow/fixed.jpg" });

    const routeCalls: Array<{ kind: string; input: any; requestId: string }> = [];
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).user = actor; next(); });
    app.use("/assets", createBatchGenerateAssetsImageRouter(async (_actor, input, requestId) => { routeCalls.push({ kind: "assets", input, requestId }); return [{ jobId: 10, targetId: 601, imageId: 20, status: "queued" }]; }));
    app.use("/edit", createGenerateFlowImageRouter(async (_actor, input, requestId) => { routeCalls.push({ kind: "edit", input, requestId }); return { jobId: 11, targetId: 1001, status: "queued" }; }));
    app.use("/novel", createAddNovelRouter(async (_actor, input, requestId) => { routeCalls.push({ kind: "novel", input, requestId }); return { novelIds: [30], items: [{ jobId: 12, targetId: 30, status: "queued" }] }; }));
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const post = (path: string, body: unknown, requestId: string) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify(body) });
      const assets = await post("/assets", { assetIds: [601], projectId: 1001, scriptId: 801, concurrentCount: 99 }, "assets-http");
      assert.equal(assets.status, 200); assert.equal((await assets.json()).data.items[0].status, "queued");
      const edit = await post("/edit", { model: "vendor:image", references: ["/oss/1001/imageFlow/source.png"], quality: "2K", ratio: "16:9", prompt: "编辑", projectId: 1001 }, "edit-http");
      assert.equal(edit.status, 200); assert.equal((await edit.json()).data.status, "queued");
      const unsafeEdit = await post("/edit", { model: "vendor:image", references: ["https://example.com/image.png"], quality: "2K", ratio: "16:9", prompt: "编辑", projectId: 1001 }, "unsafe-http");
      assert.equal(unsafeEdit.status, 400); assert.equal(routeCalls.filter((call) => call.kind === "edit").length, 1);
      const novel = await post("/novel", novelInput, "novel-http");
      assert.equal(novel.status, 200); assert.equal((await novel.json()).data.items[0].status, "queued");
      assert.deepEqual(routeCalls.map((call) => [call.kind, call.requestId]), [["assets", "assets-http"], ["edit", "edit-http"], ["novel", "novel-http"]]);
      assert.equal("concurrentCount" in routeCalls[0].input, false);
      assert.deepEqual(routeCalls[1].input.referencePaths, ["/1001/imageFlow/source.png"]);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  } finally { await db.destroy(); }
}

main().then(() => { console.log("R3G generation entrypoint tests passed"); process.exit(0); }, (error) => { console.error(error); process.exit(1); });
