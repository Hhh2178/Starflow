import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transform } from "sucrase";
import { VM } from "vm2";

const root = process.cwd();

function loadVendor(filename: string) {
  const source = fs.readFileSync(path.join(root, "data", "vendor", filename), "utf8");
  const code = transform(source, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, unknown> = {};
  const pollTask = async (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await fn();
      if (result.completed || result.error) return result;
    }
    return { completed: false, error: "timeout" };
  };
  const vm = new VM({
    timeout: 0,
    compiler: "javascript",
    eval: false,
    wasm: false,
    sandbox: {
      exports,
      fetch: globalThis.fetch,
      pollTask,
      logger: () => undefined,
      urlToBase64: async (url: string) => url,
      createOpenAI: () => ({ chat: (model: string) => ({ model }) }),
    },
  });
  vm.run(code);
  return { source, runtime: exports as Record<string, any> };
}

test("MiMo is a dedicated OpenAI-compatible text Provider", () => {
  const { source, runtime } = loadVendor("mimo.ts");
  const vendor = runtime.vendor;

  assert.equal(vendor.id, "mimo");
  assert.equal(vendor.name, "小米 MiMo");
  assert.equal(vendor.inputValues.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.deepEqual(
    vendor.models.map((model: { modelName: string; type: string }) => [model.modelName, model.type]),
    [
      ["mimo-v2.5", "text"],
      ["mimo-v2.5-pro", "text"],
    ],
  );
  assert.match(source, /createOpenAI\s*\(/);
  assert.doesNotMatch(source, /apiKey:\s*["'][^"']+["']/);
});

test("AICopy Grok preview submits JSON and polls the returned task", async () => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });

    if (url.endsWith("/v1/videos")) {
      return new Response(JSON.stringify({ task_id: "task_preview_1", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v1/videos/task_preview_1")) {
      return new Response(
        JSON.stringify({ status: "completed", video_url: "https://media.invalid/result.mp4" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const { runtime } = loadVendor("aicopy.ts");
    runtime.vendor.inputValues.apiKey = "test-key";
    runtime.vendor.inputValues.baseUrl = "https://api.aicopy.top";
    assert.deepEqual(runtime.vendor.models[0].mode, ["singleImage"]);

    const result = await runtime.videoRequest(
      {
        prompt: "镜头缓慢推进",
        duration: 6,
        resolution: "720p",
        aspectRatio: "16:9",
        mode: "singleImage",
        referenceList: [{ type: "image", sourceType: "base64", base64: "data:image/png;base64,AAAA" }],
      },
      runtime.vendor.models[0],
    );

    assert.equal(result, "https://media.invalid/result.mp4");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      url: "https://api.aicopy.top/v1/videos",
      method: "POST",
      body: {
        model: "grok-imagine-video-1.5-preview",
        prompt: "镜头缓慢推进",
        size: "1280x720",
        seconds: "6",
        images: ["data:image/png;base64,AAAA", "data:image/png;base64,AAAA"],
      },
    });
    assert.deepEqual(calls[1], {
      url: "https://api.aicopy.top/v1/videos/task_preview_1",
      method: "GET",
      body: undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AICopy Grok preview rejects missing input images before submission", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("unexpected request", { status: 500 });
  };

  try {
    const { runtime } = loadVendor("aicopy.ts");
    runtime.vendor.inputValues.apiKey = "test-key";
    await assert.rejects(
      runtime.videoRequest(
        {
          prompt: "测试",
          duration: 6,
          resolution: "720p",
          aspectRatio: "16:9",
          mode: "singleImage",
          referenceList: [],
        },
        runtime.vendor.models[0],
      ),
      /必须提供.*参考图/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GRSAI Nano Banana submits and polls with the legacy contract", async () => {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/v1/draw/nano-banana")) {
      return new Response(JSON.stringify({ code: 0, data: { id: "grsai_task_1" } }), { status: 200 });
    }
    if (url.endsWith("/v1/draw/result")) {
      return new Response(JSON.stringify({ code: 0, data: { status: "succeeded", results: [{ url: "https://media.invalid/grsai.png" }] } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  try {
    const { runtime } = loadVendor("grsai.ts");
    runtime.vendor.inputValues.apiKey = "test-key";
    runtime.vendor.inputValues.baseUrl = "https://grsai.invalid";
    const model = runtime.vendor.models.find((item: { modelName: string }) => item.modelName === "nano-banana-fast");
    const result = await runtime.imageRequest({ prompt: "星空", size: "1K", aspectRatio: "1:1", referenceList: [] }, model);
    assert.equal(result, "https://media.invalid/grsai.png");
    assert.deepEqual(calls, [
      {
        url: "https://grsai.invalid/v1/draw/nano-banana",
        method: "POST",
        body: { model: "nano-banana-fast", prompt: "星空", aspectRatio: "1:1", webHook: "-1", shutProgress: true, imageSize: "1K" },
      },
      { url: "https://grsai.invalid/v1/draw/result", method: "POST", body: { id: "grsai_task_1" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bundled Provider catalog contains MiMo, AICopy, and GRSAI", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "src", "lib", "vendor.json"), "utf8"));
  assert.equal(typeof catalog["mimo.ts"], "string");
  assert.equal(typeof catalog["aicopy.ts"], "string");
  assert.equal(typeof catalog["grsai.ts"], "string");
});
