import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { getAuthUser } from "@/middleware/auth";
import { testProviderConnection } from "@/services/adminSettings";
import { enqueueGeneration } from "@/services/generationQueue";
import {
  createRuntimeModel, createRuntimeProvider, deleteRuntimeModel, deleteRuntimeProvider,
  listRuntimeModels, listRuntimeProviders, listRuntimeTestHistory, runRuntimeTest,
  updateRuntimeModel, updateRuntimeProvider, upsertRuntimeProtocol,
} from "@/services/providerRuntime/adminService";

const id = z.string().trim().min(1).max(128);
const provider = z.strictObject({ providerId: id, displayName: z.string().trim().min(1).max(200), enabled: z.boolean(), migrationState: z.enum(["legacy", "shadow", "native"]), adapterId: id });
const model = z.strictObject({ providerId: id, modelId: id, displayName: z.string().trim().min(1).max(200), capability: z.enum(["text", "image", "video", "audio", "json"]), executionMode: z.enum(["sync", "background_poll", "webhook", "runninghub", "legacy"]), parameterSchema: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean() });
const protocol = z.strictObject({ providerId: id, protocolType: z.enum(["standard", "poll", "webhook", "runninghub", "legacy"]), config: z.record(z.string(), z.unknown()), enabled: z.boolean(), expectedRevision: z.number().int().positive().optional() });

function sendFailure(res: express.Response, cause: unknown) {
  const known = cause as { status?: number; code?: string; message?: string };
  return res.status(Number(known.status ?? 500)).send(error(known.message ?? "Provider Runtime 操作失败", { code: known.code ?? "PROVIDER_RUNTIME_FAILED" }));
}

export function createProviderRuntimeAdminRouter() {
  const router = express.Router();
  router.get("/providers", async (req, res) => { try { return res.send(success(await listRuntimeProviders(getAuthUser(req)))); } catch (cause) { return sendFailure(res, cause); } });
  router.get("/models", async (req, res) => {
    try { return res.send(success(await listRuntimeModels(getAuthUser(req), { page: Number(req.query.page || 1), pageSize: Number(req.query.pageSize || 20), query: req.query.query as string | undefined, capability: req.query.capability as string | undefined, executionMode: req.query.executionMode as string | undefined, enabled: req.query.enabled === undefined ? undefined : req.query.enabled === "true" }))); } catch (cause) { return sendFailure(res, cause); }
  });
  router.post("/providers", async (req, res) => { const parsed = provider.safeParse(req.body); if (!parsed.success) return res.status(400).send(error("参数无效", { code: "INVALID_PARAMETERS" })); try { return res.send(success(await createRuntimeProvider(getAuthUser(req), parsed.data))); } catch (cause) { return sendFailure(res, cause); } });
  router.patch("/providers/:providerId", async (req, res) => {
    const parsed = provider.omit({ providerId: true }).partial().extend({ expectedRevision: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("参数无效", { code: "INVALID_PARAMETERS" }));
    const { expectedRevision, ...patch } = parsed.data; try { return res.send(success(await updateRuntimeProvider(getAuthUser(req), req.params.providerId, expectedRevision, patch))); } catch (cause) { return sendFailure(res, cause); }
  });
  router.delete("/providers/:providerId", async (req, res) => { try { return res.send(success(await deleteRuntimeProvider(getAuthUser(req), req.params.providerId))); } catch (cause) { return sendFailure(res, cause); } });
  router.post("/models", async (req, res) => { const parsed = model.safeParse(req.body); if (!parsed.success) return res.status(400).send(error("参数无效", { code: "INVALID_PARAMETERS" })); try { return res.send(success(await createRuntimeModel(getAuthUser(req), parsed.data))); } catch (cause) { return sendFailure(res, cause); } });
  router.patch("/models/:providerId/:modelId", async (req, res) => {
    const parsed = model.omit({ providerId: true, modelId: true }).partial().extend({ expectedRevision: z.number().int().positive() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("参数无效", { code: "INVALID_PARAMETERS" }));
    const { expectedRevision, ...patch } = parsed.data; try { return res.send(success(await updateRuntimeModel(getAuthUser(req), req.params.providerId, req.params.modelId, expectedRevision, patch))); } catch (cause) { return sendFailure(res, cause); }
  });
  router.delete("/models/:providerId/:modelId", async (req, res) => { try { return res.send(success(await deleteRuntimeModel(getAuthUser(req), req.params.providerId, req.params.modelId))); } catch (cause) { return sendFailure(res, cause); } });
  router.put("/protocols", async (req, res) => { const parsed = protocol.safeParse(req.body); if (!parsed.success) return res.status(400).send(error("参数无效", { code: "INVALID_PARAMETERS" })); try { return res.send(success(await upsertRuntimeProtocol(getAuthUser(req), parsed.data))); } catch (cause) { return sendFailure(res, cause); } });
  router.post("/tests/connection", async (req, res) => {
    const parsed = z.strictObject({ providerId: id, modelId: id }).safeParse(req.body); if (!parsed.success) return res.status(400).send(error("参数无效", { code: "INVALID_PARAMETERS" }));
    const actor = getAuthUser(req); try { return res.send(success(await runRuntimeTest(actor, { ...parsed.data, testType: "connection" }, () => testProviderConnection(actor, { id: parsed.data.providerId, modelName: parsed.data.modelId })))); } catch (cause) { return sendFailure(res, cause); }
  });
  router.post("/tests/generation", async (req, res) => {
    const parsed = z.strictObject({ providerId: id, modelId: id, confirmBillable: z.literal(true), projectId: z.number().int().positive(), handlerKey: id, taskType: z.enum(["text", "image", "video"]), payload: z.record(z.string(), z.unknown()), idempotencyKey: id }).safeParse(req.body);
    if (!parsed.success) return res.status(400).send(error("参数无效", { code: "INVALID_PARAMETERS" }));
    const actor = getAuthUser(req); const { providerId, modelId, confirmBillable, ...queue } = parsed.data;
    try { return res.send(success(await runRuntimeTest(actor, { providerId, modelId, testType: "generation", confirmBillable }, () => enqueueGeneration(actor, { ...queue, payload: { ...queue.payload, providerId, modelId, model: `${providerId}:${modelId}` } })))); } catch (cause) { return sendFailure(res, cause); }
  });
  router.get("/tests/:providerId", async (req, res) => { try { return res.send(success(await listRuntimeTestHistory(getAuthUser(req), req.params.providerId))); } catch (cause) { return sendFailure(res, cause); } });
  return router;
}

export default createProviderRuntimeAdminRouter();
