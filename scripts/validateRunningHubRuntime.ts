import { createRunningHubExecutionService, type RunningHubDescriptor } from "@/services/providerRuntime/runningHubService";

async function main() {
  if (process.env.RUNNINGHUB_REAL_VALIDATION !== "1") {
    console.log("RunningHub real validation skipped; set RUNNINGHUB_REAL_VALIDATION=1 explicitly.");
    return;
  }
  const apiKey = process.env.RUNNINGHUB_API_KEY?.trim();
  const appId = process.env.RUNNINGHUB_APP_ID?.trim();
  const workflowId = process.env.RUNNINGHUB_WORKFLOW_ID?.trim();
  const validationMode = process.env.RUNNINGHUB_VALIDATION_MODE?.trim() || "both";
  const budget = Number(process.env.RUNNINGHUB_MANUAL_QUOTA_CNY);
  const baseUrl = process.env.RUNNINGHUB_BASE_URL?.trim() || "https://www.runninghub.cn";
  if (process.env.RUNNINGHUB_ACCEPTANCE_SCOPE !== "non-production") throw new Error("RUNNINGHUB_ACCEPTANCE_SCOPE must be non-production");
  if (!Number.isFinite(budget) || budget <= 0 || budget > 1) throw new Error("RUNNINGHUB_MANUAL_QUOTA_CNY must be greater than 0 and no more than 1");
  if (!["app", "workflow", "both"].includes(validationMode)) throw new Error("RUNNINGHUB_VALIDATION_MODE must be app, workflow or both");
  const resourceTypes: Array<"app" | "workflow"> = validationMode === "app" ? ["app"] : validationMode === "workflow" ? ["workflow"] : ["app", "workflow"];
  if (!apiKey) throw new Error("RUNNINGHUB_API_KEY is required");
  if (resourceTypes.includes("app") && !appId) throw new Error("RUNNINGHUB_APP_ID is required for App validation");
  if (resourceTypes.includes("workflow") && !workflowId) throw new Error("RUNNINGHUB_WORKFLOW_ID is required for Workflow validation");
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
  const imageValue = process.env.RUNNINGHUB_APP_IMAGE_VALUE?.trim();
  const descriptors: RunningHubDescriptor[] = resourceTypes.map((resourceType) => {
    const uploadMapping: RunningHubDescriptor["uploadMapping"] = resourceType === "app" && imageValue
      ? { image: { nodeId: process.env.RUNNINGHUB_IMAGE_NODE_ID || "1", fieldName: process.env.RUNNINGHUB_IMAGE_FIELD || "image" } }
      : {};
    return {
      providerId: "runninghub", modelId: `real-validation-${resourceType}`, resourceType,
      resourceId: resourceType === "app" ? appId! : workflowId!,
      inputMapping: { prompt: { nodeId: process.env.RUNNINGHUB_PROMPT_NODE_ID || "1", fieldName: process.env.RUNNINGHUB_PROMPT_FIELD || "prompt" } },
      uploadMapping,
      outputRule: { kind: process.env.RUNNINGHUB_OUTPUT_KIND === "image" ? "image" : process.env.RUNNINGHUB_OUTPUT_KIND === "audio" ? "audio" : "video", path: "data" },
      pollingIntervalMs: 5000, timeoutMs: 600000, enabled: true,
    };
  });
  const results: Array<{ resourceType: "app" | "workflow"; outputCount: number }> = [];
  for (const descriptor of descriptors) {
    const result = await service.execute(descriptor, { prompt: process.env.RUNNINGHUB_VALIDATION_PROMPT || "low cost validation", ...(imageValue ? { image: imageValue } : {}) });
    results.push({ resourceType: descriptor.resourceType, outputCount: result.outputs.length });
  }
  console.log(JSON.stringify({ ok: true, scope: "non-production", manualQuotaCny: budget, results }));
}

main().catch(() => {
  console.error("RunningHub controlled validation failed; no credential, payload, output or URL was logged.");
  process.exit(1);
});
