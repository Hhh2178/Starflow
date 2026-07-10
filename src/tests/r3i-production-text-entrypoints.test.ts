import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import type { AuthUser } from "@/types/auth";
import {
  createBatchBindAudioRouter,
  createBatchPolishAssetsPromptRouter,
  createExtractAssetsRouter,
  createExtractStylePromptRouter,
  createGetAiRegexRouter,
  createPolishAssetsPromptRouter,
} from "@/lib/productionTextQueueRoutes";

type Call = { kind: string; actor: AuthUser; input: any; requestId: string };

async function main() {
  const actor: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };
  const calls: Call[] = [];
  const enqueue = (kind: string) => async (requestActor: AuthUser, input: any, requestId: string) => {
    calls.push({ kind, actor: requestActor, input, requestId });
    const targetIds = input.assetIds ?? input.scriptIds ?? [input.assetId ?? input.projectId];
    return targetIds.map((targetId: number, index: number) => ({
      jobId: 9000 + calls.length * 10 + index,
      targetId,
      status: "queued" as const,
    }));
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = actor; next(); });
  app.use("/style", createExtractStylePromptRouter(enqueue("style") as any));
  app.use("/polish", createPolishAssetsPromptRouter(enqueue("polish") as any));
  app.use("/batch-polish", createBatchPolishAssetsPromptRouter(enqueue("batch-polish") as any));
  app.use("/audio", createBatchBindAudioRouter(enqueue("audio") as any));
  app.use("/extract-assets", createExtractAssetsRouter(enqueue("extract-assets") as any));
  app.use("/regex", createGetAiRegexRouter(enqueue("regex") as any));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const post = async (route: string, body: unknown, requestId: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, `${route} should enqueue successfully`);
      return (await response.json()) as any;
    };

    const style = await post("/style", { projectId: 1001, images: ["/oss/1001/style/a.jpg"] }, "style-req");
    assert.equal(style.data.status, "queued");

    const polish = await post("/polish", {
      projectId: 1001,
      assetsId: 601,
      type: "role",
      name: "角色甲",
      describe: "设定",
    }, "polish-req");
    assert.equal(polish.data.targetId, 601);

    const batchPolish = await post("/batch-polish", {
      projectId: 1001,
      items: [
        { assetsId: 601, type: "role", name: "角色甲", describe: "设定" },
        { assetsId: 602, type: "scene", name: "场景甲", describe: "设定" },
      ],
      concurrentCount: 99,
      otherTextPrompt: "保持统一",
    }, "batch-polish-req");
    assert.equal(batchPolish.data.items.length, 2);

    const audio = await post("/audio", {
      projectId: 1001,
      assetsIds: [601, 602],
      concurrentCount: 99,
    }, "audio-req");
    assert.equal(audio.data.items.length, 2);

    const extractAssets = await post("/extract-assets", {
      projectId: 1001,
      scriptIds: [801, 802],
      groupSize: 99,
    }, "extract-assets-req");
    assert.equal(extractAssets.data.items.length, 2);

    const regex = await post("/regex", {
      projectId: 1001,
      content: "第1集 开始",
    }, "regex-req");
    assert.equal(regex.data.status, "queued");

    assert.deepEqual(calls, [
      { kind: "style", actor, requestId: "style-req", input: { projectId: 1001, images: ["/oss/1001/style/a.jpg"] } },
      { kind: "polish", actor, requestId: "polish-req", input: { projectId: 1001, assetIds: [601], otherTextPrompt: "" } },
      { kind: "batch-polish", actor, requestId: "batch-polish-req", input: { projectId: 1001, assetIds: [601, 602], otherTextPrompt: "保持统一" } },
      { kind: "audio", actor, requestId: "audio-req", input: { projectId: 1001, assetIds: [601, 602] } },
      { kind: "extract-assets", actor, requestId: "extract-assets-req", input: { projectId: 1001, scriptIds: [801, 802] } },
      { kind: "regex", actor, requestId: "regex-req", input: { projectId: 1001, content: "第1集 开始" } },
    ]);
    for (const call of calls) {
      assert.equal("concurrentCount" in call.input, false);
      assert.equal("groupSize" in call.input, false);
      assert.equal(call.actor.id, actor.id);
      assert.equal(call.actor.groupId, actor.groupId);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().then(
  () => console.log("R3I production text entrypoint tests passed"),
  (error) => { console.error(error); process.exitCode = 1; },
);
