import { createRunningHubExecutionService, type RunningHubDescriptor } from "@/services/providerRuntime/runningHubService";

async function main() {
  if (process.env.RUNNINGHUB_REAL_VALIDATION !== "1") {
    console.log("RunningHub real validation skipped; set RUNNINGHUB_REAL_VALIDATION=1 explicitly.");
    return;
  }
  const apiKey = process.env.RUNNINGHUB_API_KEY?.trim();
  const resourceId = process.env.RUNNINGHUB_RESOURCE_ID?.trim();
  const resourceType = process.env.RUNNINGHUB_RESOURCE_TYPE === "app" ? "app" : "workflow";
  const baseUrl = process.env.RUNNINGHUB_BASE_URL?.trim() || "https://www.runninghub.cn";
  if (!apiKey || !resourceId) throw new Error("RUNNINGHUB_API_KEY and RUNNINGHUB_RESOURCE_ID are required");
  const counters = new Map<string, number>();
  const service = await createRunningHubExecutionService({
    baseUrl,
    keys: [{ id: "validation", credentialRef: "env://RUNNINGHUB_API_KEY", maxConcurrency: 1, enabled: true, isDefault: true }],
    resolveCredential: async (reference) => reference === "env://RUNNINGHUB_API_KEY" ? apiKey : null,
    keyRuntime: {
      get: async (key) => String(counters.get(key) ?? 0),
      incr: async (key) => { const next = (counters.get(key) ?? 0) + 1; counters.set(key, next); return next; },
      decr: async (key) => { const next = (counters.get(key) ?? 0) - 1; counters.set(key, next); return next; },
      del: async (key) => { counters.delete(key); },
      expire: async () => undefined,
    },
    hostConcurrency: { acquire: async () => ({ leaseId: "validation" }), release: async () => undefined },
  });
  const descriptor: RunningHubDescriptor = {
    providerId: "runninghub",
    modelId: "real-validation",
    resourceType,
    resourceId,
    inputMapping: { prompt: { nodeId: process.env.RUNNINGHUB_PROMPT_NODE_ID || "1", fieldName: process.env.RUNNINGHUB_PROMPT_FIELD || "prompt" } },
    uploadMapping: {},
    outputRule: { kind: process.env.RUNNINGHUB_OUTPUT_KIND === "image" ? "image" : process.env.RUNNINGHUB_OUTPUT_KIND === "audio" ? "audio" : "video", path: "data" },
    pollingIntervalMs: 5000,
    timeoutMs: 600000,
    enabled: true,
  };
  const result = await service.execute(descriptor, { prompt: process.env.RUNNINGHUB_VALIDATION_PROMPT || "low cost validation" });
  console.log(JSON.stringify({ ok: true, taskId: result.taskId, outputCount: result.outputs.length }));
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : "RunningHub validation failed");
  process.exit(1);
});
