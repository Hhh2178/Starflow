import assert from "node:assert/strict";
import knex from "knex";
import initDB from "@/lib/initDB";
import type { GenerationExecutionContext } from "@/types/generationQueue";
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const module = await import("@/jobs/acceptanceRegistry") as any;
  assert.equal(typeof module.createAcceptanceGenerationRegistry, "function");

  const db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await initDB(db, false, true);
    await db("o_group").insert({ id: 101, name: "验收组", creatorLimit: 2, status: "enabled", createdAt: 1, updatedAt: 1 });
    await db("o_user").insert({ id: 201, name: "creator", role: "creator", status: "enabled", groupId: 101, createdAt: 1, updatedAt: 1 });
    await db("o_project").insert({ id: 301, name: "验收项目", projectType: "novel", ownerUserId: 201, userId: 201, groupId: 101 });
    await db("o_generationJob").insert({ id: 401, groupId: 101, ownerUserId: 201, projectId: 301, handlerKey: "core.text", taskType: "text", status: "running", priority: 0, payloadJson: "{}", idempotencyKey: "acceptance-agent", queuedAt: 1 });

    const registry = module.createAcceptanceGenerationRegistry({ connection: db, delayMs: 30 });
    assert.deepEqual(registry.keys().sort(), ["core.image", "core.text", "core.video"]);
    const coreModule = await import("@/jobs/coreRegistry") as any;
    assert.equal(typeof coreModule.selectGenerationRegistry, "function");
    assert.equal(coreModule.selectGenerationRegistry({ connection: db, acceptanceMode: false }), coreModule.coreGenerationRegistry);
    assert.notEqual(coreModule.selectGenerationRegistry({ connection: db, acceptanceMode: true, delayMs: 30 }), coreModule.coreGenerationRegistry);

    const providerMarks: string[] = [];
    const context = (signal: AbortSignal): GenerationExecutionContext => ({
      jobId: 401,
      groupId: 101,
      ownerUserId: 201,
      projectId: 301,
      signal,
      heartbeat: async () => undefined,
      setProviderRequestId: async (id) => { providerMarks.push(id); },
    });
    const text = registry.get("core.text")!;

    const startedAt = Date.now();
    const success = await text.execute(context(new AbortController().signal), text.parsePayload({
      operation: "script_agent", projectId: 301, targetId: 301, model: "universalAi",
      prompt: "生成验收方案", isolationKey: "301:acceptance", thinkLevel: 0,
    }));
    assert.ok(Date.now() - startedAt >= 20, "fake handler must remain observable as running");
    assert.equal((success.result as any).agentType, "script_agent");
    assert.ok((success.result as any).eventCount >= 4);
    assert.ok(providerMarks.some((id) => id.startsWith("acceptance:")));
    assert.deepEqual((await db("o_agentJobEvent").where({ jobId: 401 }).orderBy("sequence").pluck("event")), [
      "message", "content:add", "content:update", "message:update",
    ]);

    await assert.rejects(text.execute(context(new AbortController().signal), text.parsePayload({
      operation: "script_agent", projectId: 301, targetId: 301, model: "universalAi",
      prompt: "[验收失败]", isolationKey: "301:failure", thinkLevel: 0,
    })), /验收任务按预期失败/);

    const abortController = new AbortController();
    const cancelled = text.execute(context(abortController.signal), text.parsePayload({
      operation: "script_agent", projectId: 301, targetId: 301, model: "universalAi",
      prompt: "取消验收", isolationKey: "301:cancel", thinkLevel: 0,
    }));
    setTimeout(() => abortController.abort(), 5);
    await assert.rejects(cancelled, (error: any) => error?.name === "AbortError");

    await db("o_image").insert({ id: 601, assetsId: 501, type: "role", state: "" });
    await db("o_assets").insert({ id: 501, name: "验收角色", type: "role", projectId: 301, imageId: 601 });
    const image = registry.get("core.image")!;
    const imageResult = await image.execute(context(new AbortController().signal), image.parsePayload({
      operation: "asset", projectId: 301, targetId: 601, model: "null:acceptance-image",
      prompt: "本地占位图", referenceResourceIds: [], size: "1K", aspectRatio: "16:9",
    }));
    const storedImage = await db("o_image").where({ id: 601 }).first();
    assert.equal(storedImage.state, "已完成");
    assert.equal((imageResult.result as any).path, "/oss/acceptance/301-601.png");
    await fs.access(path.resolve("data", "oss", "acceptance", "301-601.png"));

    await db("o_video").insert({ id: 701, projectId: 301, scriptId: 1, videoTrackId: 1, filePath: "/301/video/701.mp4", state: "生成中" });
    const video = registry.get("core.video")!;
    await video.execute(context(new AbortController().signal), video.parsePayload({
      operation: "track", projectId: 301, targetId: 701, model: "null:acceptance-video",
      prompt: "本地视频", referenceResourceIds: [], referenceResources: [], duration: 5,
      resolution: "720p", aspectRatio: "16:9", audio: false, mode: "text",
    }));
    assert.equal((await db("o_video").where({ id: 701 }).first()).state, "已完成");
  } finally {
    await db.destroy();
  }
}

main().then(
  () => { console.log("R3N acceptance generation tests passed"); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);
