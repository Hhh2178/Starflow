import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  RunningHubDescriptorError,
  createRunningHubExecutionService,
  deserializeRunningHubDescriptor,
  sanitizeRunningHubKeyPool,
  serializeRunningHubDescriptor,
  validateRunningHubKeyReferences,
  validateRunningHubDescriptor,
  type RunningHubDescriptor,
} from "@/services/providerRuntime/runningHubService";

const descriptor = (resourceType: "app" | "workflow"): RunningHubDescriptor => ({
  providerId: "runninghub",
  modelId: `${resourceType}-model`,
  resourceType,
  resourceId: `${resourceType}-123`,
  inputMapping: { prompt: { nodeId: "10", fieldName: "text" } },
  uploadMapping: { image: { nodeId: "20", fieldName: "image" } },
  outputRule: { kind: "video", path: "data.results" },
  pollingIntervalMs: 1000,
  timeoutMs: 10000,
  enabled: true,
});

test("RunningHub descriptor validates App/Workflow mappings and bounded polling", () => {
  assert.equal(validateRunningHubDescriptor(descriptor("app")).resourceId, "app-123");
  assert.equal(validateRunningHubDescriptor(descriptor("workflow")).resourceType, "workflow");
  const invalid = descriptor("app");
  invalid.inputMapping.prompt.nodeId = "";
  invalid.pollingIntervalMs = 50;
  assert.throws(() => validateRunningHubDescriptor(invalid), (cause: unknown) => {
    assert.equal(cause instanceof RunningHubDescriptorError, true);
    assert.deepEqual(new Set((cause as RunningHubDescriptorError).issues.map((issue) => issue.code)), new Set(["INVALID_NODE_ID", "POLL_INTERVAL_OUT_OF_RANGE"]));
    return true;
  });
});

test("RunningHub key summaries expose references/counts and never values", () => {
  const summary = sanitizeRunningHubKeyPool([
    { id: "key-a", credentialRef: "secret://runninghub/a", maxConcurrency: 2, enabled: true, isDefault: true },
    { id: "key-b", credentialRef: "secret://runninghub/b", maxConcurrency: 1, enabled: false, isDefault: false },
  ]);
  assert.deepEqual(summary, { total: 2, enabled: 1, defaultKeyId: "key-a", keys: [{ id: "key-a", maxConcurrency: 2, enabled: true, isDefault: true }, { id: "key-b", maxConcurrency: 1, enabled: false, isDefault: false }] });
  assert.equal(JSON.stringify(summary).includes("secret://"), false);
  assert.throws(() => validateRunningHubKeyReferences([{ id: "raw", credentialRef: "plain-secret", maxConcurrency: 1, enabled: true, isDefault: true, apiKey: "must-not-store" } as any]), /credentialRef only/);
});

test("RunningHub descriptors round-trip through reference-only database columns", () => {
  const source = descriptor("workflow");
  const row = serializeRunningHubDescriptor(source);
  assert.equal(Object.keys(row).some((key) => /key|secret|credential/i.test(key)), false);
  assert.deepEqual(deserializeRunningHubDescriptor(row), source);
});

for (const resourceType of ["app", "workflow"] as const) {
  test(`RunningHub ${resourceType} fake acceptance maps nodes, polls, and releases both concurrency leases`, async () => {
    const calls: Array<{ url: string; body: any; authorization: string | null }> = [];
    const counters = new Map<string, number>();
    const runtime = {
      get: async (key: string) => String(counters.get(key) ?? 0),
      incr: async (key: string) => { const value = (counters.get(key) ?? 0) + 1; counters.set(key, value); return value; },
      decr: async (key: string) => { const value = (counters.get(key) ?? 0) - 1; counters.set(key, value); return value; },
      del: async (key: string) => { counters.delete(key); },
      expire: async () => undefined,
    };
    let hostInFlight = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
      if (!url.endsWith("/openapi/v2/query")) return new Response(JSON.stringify({ code: 0, data: { taskId: "rh-task-1" } }), { status: 200 });
      return new Response(JSON.stringify({ code: 0, status: "SUCCESS", data: { results: [{ url: "https://media.invalid/result.mp4" }] } }), { status: 200 });
    };
    const service = await createRunningHubExecutionService({
      baseUrl: "https://runninghub.invalid",
      keys: [{ id: "key-a", credentialRef: "secret://runninghub/a", maxConcurrency: 1, enabled: true, isDefault: true }],
      resolveCredential: async (reference) => reference === "secret://runninghub/a" ? "rh-secret-value" : null,
      keyRuntime: runtime,
      hostConcurrency: {
        acquire: async () => { hostInFlight += 1; return { leaseId: "host-1" }; },
        release: async () => { hostInFlight -= 1; },
      },
      fetcher,
      wait: async () => undefined,
    });
    const result = await service.execute(descriptor(resourceType), { prompt: "hello", image: "https://media.invalid/input.png" });
    assert.equal(result.taskId, "rh-task-1");
    assert.deepEqual(result.outputs, [{ kind: "video", url: "https://media.invalid/result.mp4" }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].authorization, "Bearer rh-secret-value");
    assert.deepEqual(calls[0].body.nodeInfoList, [{ nodeId: "10", fieldName: "text", fieldValue: "hello" }, { nodeId: "20", fieldName: "image", fieldValue: "https://media.invalid/input.png" }]);
    if (resourceType === "workflow") {
      assert.deepEqual(calls[0].body, {
        addMetadata: true,
        nodeInfoList: [{ nodeId: "10", fieldName: "text", fieldValue: "hello" }, { nodeId: "20", fieldName: "image", fieldValue: "https://media.invalid/input.png" }],
        instanceType: "default",
        usePersonalQueue: "false",
      });
    }
    assert.equal(hostInFlight, 0);
    assert.equal(counters.size, 0);
  });
}

test("RunningHub cancellation releases host and key leases exactly once", async () => {
  let hostReleases = 0;
  let keyReleases = 0;
  const controller = new AbortController();
  const values = new Map<string, number>();
  const service = await createRunningHubExecutionService({
    baseUrl: "https://runninghub.invalid",
    keys: [{ id: "key-a", credentialRef: "secret://runninghub/a", maxConcurrency: 1, enabled: true, isDefault: true }],
    resolveCredential: async () => "secret",
    keyRuntime: {
      get: async (key) => String(values.get(key) ?? 0),
      incr: async (key) => { values.set(key, 1); return 1; },
      decr: async (key) => { keyReleases += 1; values.set(key, 0); return 0; },
      del: async (key) => { values.delete(key); },
      expire: async () => undefined,
    },
    hostConcurrency: { acquire: async () => ({ leaseId: "host" }), release: async () => { hostReleases += 1; } },
    fetcher: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); },
    wait: async () => undefined,
  });
  await assert.rejects(service.execute(descriptor("workflow"), { prompt: "cancel", image: "x" }, { signal: controller.signal }), /aborted/i);
  assert.equal(hostReleases, 1);
  assert.equal(keyReleases, 1);
});

test("RunningHub real validator supports one-target App acceptance without logging secrets or payloads", () => {
  const source = fs.readFileSync("scripts/validateRunningHubRuntime.ts", "utf8");
  assert.match(source, /RUNNINGHUB_VALIDATION_MODE/);
  assert.match(source, /RUNNINGHUB_APP_IMAGE_VALUE/);
  assert.match(source, /RUNNINGHUB_IMAGE_NODE_ID/);
  assert.match(source, /resourceTypes/);
  assert.doesNotMatch(source, /console\.error\(cause instanceof Error \? cause\.message/);
  assert.match(source, /no credential, payload, output or URL was logged/);
});
