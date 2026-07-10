import type { Knex } from "knex";
import type { AuthUser } from "@/types/auth";
import type { GenerationExecutionContext, GenerationExecutionResult } from "@/types/generationQueue";
import type { TextGenerationPayload } from "@/jobs/handlers/textGeneration";
import { enqueueGeneration, GenerationQueueError, getGenerationJob } from "@/services/generationQueue";
import type { QueuedWorkflowItem } from "@/services/generationWorkflows";
import { enqueueAssetImageJobs, enqueueStoryboardImageJobs } from "@/services/generationWorkflows";

type QueueConnection = Knex | Knex.Transaction;
type AgentPayload = Extract<TextGenerationPayload, { operation: "script_agent" | "production_agent" }>;

export interface EnqueueAgentChatInput {
  agentType: AgentPayload["operation"];
  projectId: number;
  scriptId?: number;
  prompt: string;
  isolationKey: string;
  thinkLevel: number;
}

export interface AgentJobEvent {
  sequence: number;
  event: string;
  data: unknown;
  createdAt: number;
}

export interface AgentRuntime {
  payload: AgentPayload;
  context: GenerationExecutionContext;
  socket: PersistentAgentEventSocket;
}

export interface AgentEventSocketContext {
  actor: AuthUser;
  projectId: number;
  scriptId?: number;
  requestId: string;
}

export interface ExecuteQueuedAgentDependencies {
  connection?: QueueConnection;
  runScriptAgent?: (runtime: AgentRuntime) => Promise<void>;
  runProductionAgent?: (runtime: AgentRuntime) => Promise<void>;
}

async function resolveConnection(connection?: QueueConnection): Promise<QueueConnection> {
  if (connection) return connection;
  return (await import("@/utils/db")).db;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function appendAgentJobEvent(
  jobId: number,
  event: string,
  data: unknown,
  connection?: QueueConnection,
  createdAt: number = Date.now(),
): Promise<number> {
  const resolved = await resolveConnection(connection);
  const insert = async (trx: Knex.Transaction) => {
    const latest = await trx("o_agentJobEvent").where({ jobId }).max({ sequence: "sequence" }).first();
    const sequence = Number(latest?.sequence ?? 0) + 1;
    await trx("o_agentJobEvent").insert({ jobId, sequence, event, dataJson: JSON.stringify(data ?? null), createdAt });
    return sequence;
  };
  if ((resolved as Knex.Transaction).isTransaction) return insert(resolved as Knex.Transaction);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await (resolved as Knex).transaction(insert);
    } catch (error: any) {
      const retryable = error?.code === "SQLITE_BUSY"
        || error?.code === "SQLITE_LOCKED"
        || (error?.code === "SQLITE_CONSTRAINT_UNIQUE" && String(error?.message).includes("o_agentJobEvent"));
      if (!retryable || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
}

export async function listAgentJobEvents(
  jobId: number,
  afterSequence: number = 0,
  connection?: QueueConnection,
): Promise<AgentJobEvent[]> {
  const resolved = await resolveConnection(connection);
  const rows = await resolved("o_agentJobEvent").where({ jobId }).andWhere("sequence", ">", afterSequence).orderBy("sequence", "asc");
  return rows.map((row: any) => ({
    sequence: Number(row.sequence),
    event: String(row.event),
    data: parseJson(row.dataJson),
    createdAt: Number(row.createdAt),
  }));
}

export async function listScopedAgentJobEvents(
  actor: AuthUser,
  input: { jobId: number; projectId: number; scriptId?: number; afterSequence?: number },
  connection?: QueueConnection,
): Promise<AgentJobEvent[]> {
  const resolved = await resolveConnection(connection);
  const detail = await getGenerationJob(actor, input.jobId, resolved);
  const row = await resolved("o_generationJob").where({ id: input.jobId }).select("handlerKey", "payloadJson").first();
  const payload = parseJson(row?.payloadJson) as (Partial<AgentPayload> & { scriptId?: number }) | null;
  const expectedOperation = input.scriptId == null ? "script_agent" : "production_agent";
  if (
    detail.projectId !== input.projectId
    || detail.handlerKey !== "core.text"
    || payload?.operation !== expectedOperation
    || (input.scriptId != null && (detail.sourceTaskId !== input.scriptId || payload?.scriptId !== input.scriptId))
  ) {
    throw new GenerationQueueError(404, "JOB_NOT_FOUND", "任务不存在");
  }
  return listAgentJobEvents(input.jobId, Math.max(0, Math.trunc(input.afterSequence ?? 0)), resolved);
}

function parseObject(value: unknown): Record<string, any> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
}

async function getPlanData(context: AgentEventSocketContext, connection: QueueConnection): Promise<Record<string, any>> {
  const row = await connection("o_agentWorkData").where({ projectId: context.projectId, key: "scriptAgent" }).first();
  const data = parseObject(row?.data);
  data.script = await connection("o_script").where({ projectId: context.projectId }).select("id", "name", "content");
  return data;
}

async function getFlowData(context: AgentEventSocketContext, connection: QueueConnection): Promise<Record<string, any>> {
  if (!context.scriptId) throw new GenerationQueueError(422, "AGENT_SCRIPT_REQUIRED", "Production Agent 必须选择剧本");
  const [workRow, script, scriptAssets, storyboards] = await Promise.all([
    connection("o_agentWorkData").where({ projectId: context.projectId, episodesId: context.scriptId }).first(),
    connection("o_script").where({ id: context.scriptId, projectId: context.projectId }).first(),
    connection("o_scriptAssets").where({ scriptId: context.scriptId }).select("assetId"),
    connection("o_storyboard").where({ projectId: context.projectId, scriptId: context.scriptId }).orderBy("index", "asc"),
  ]);
  if (!script) throw new GenerationQueueError(404, "SCRIPT_NOT_FOUND", "剧本不存在或不属于当前项目");
  const assetIds = scriptAssets.map((item: any) => Number(item.assetId));
  const assets = assetIds.length
    ? await connection("o_assets")
      .where({ projectId: context.projectId })
      .andWhere((builder) => builder.whereIn("id", assetIds).orWhereIn("assetsId", assetIds))
    : [];
  const data = parseObject(workRow?.data);
  const storyboardIds = storyboards.map((item: any) => Number(item.id));
  const relations = storyboardIds.length ? await connection("o_assets2Storyboard").whereIn("storyboardId", storyboardIds) : [];
  data.script = script.content ?? "";
  data.assets = assets.filter((item: any) => item.assetsId == null).map((item: any) => ({
    id: Number(item.id), name: item.name ?? "", type: item.type ?? "", prompt: item.prompt ?? "", desc: item.describe ?? "",
    derive: assets.filter((child: any) => Number(child.assetsId) === Number(item.id)).map((child: any) => ({ id: Number(child.id), assetsId: Number(item.id), name: child.name ?? "", type: child.type ?? "", prompt: child.prompt ?? "", desc: child.describe ?? "" })),
  }));
  data.storyboard = storyboards.map((item: any) => ({
    id: Number(item.id), index: item.index, duration: Number(item.duration ?? 0), prompt: item.prompt,
    associateAssetsIds: relations.filter((relation: any) => Number(relation.storyboardId) === Number(item.id)).map((relation: any) => Number(relation.assetId)),
    state: item.state, videoDesc: item.videoDesc, shouldGenerateImage: item.shouldGenerateImage, reason: item.reason ?? "",
  }));
  data.scriptPlan ??= "";
  data.storyboardTable ??= "";
  data.workbench ??= { videoList: [] };
  return data;
}

async function addDeriveAsset(context: AgentEventSocketContext, raw: any, connection: QueueConnection): Promise<any> {
  if (!context.scriptId) throw new GenerationQueueError(422, "AGENT_SCRIPT_REQUIRED", "Production Agent 必须选择剧本");
  const parent = await connection("o_assets").where({ id: Number(raw?.assetsId), projectId: context.projectId }).whereNull("assetsId").first();
  if (!parent) throw new GenerationQueueError(404, "ASSET_NOT_FOUND", "关联资产不存在或不属于当前项目");
  const data = { assetsId: Number(parent.id), projectId: context.projectId, name: String(raw?.name ?? ""), type: parent.type, describe: String(raw?.describe ?? raw?.desc ?? ""), startTime: Date.now() };
  if (raw?.id != null) {
    const updated = await connection("o_assets").where({ id: Number(raw.id), projectId: context.projectId, assetsId: Number(parent.id) }).update(data);
    if (!updated) throw new GenerationQueueError(404, "DERIVE_ASSET_NOT_FOUND", "衍生资产不存在或不属于当前项目");
    return { ...data, id: Number(raw.id) };
  }
  const [id] = await connection("o_assets").insert(data);
  await connection("o_scriptAssets").insert({ scriptId: context.scriptId, assetId: Number(id) });
  return { ...data, id: Number(id) };
}

async function delDeriveAsset(context: AgentEventSocketContext, raw: any, connection: QueueConnection): Promise<{ id: number }> {
  if (!context.scriptId) throw new GenerationQueueError(422, "AGENT_SCRIPT_REQUIRED", "Production Agent 必须选择剧本");
  const id = Number(raw?.id);
  const asset = await connection("o_assets").where({ id, projectId: context.projectId, assetsId: Number(raw?.assetsId) }).first();
  if (!asset) throw new GenerationQueueError(404, "DERIVE_ASSET_NOT_FOUND", "衍生资产不存在或不属于当前项目");
  await connection.transaction(async (trx) => {
    await trx("o_scriptAssets").where({ scriptId: context.scriptId, assetId: id }).delete();
    await trx("o_assets").where({ id }).delete();
  });
  return { id };
}

async function addStoryboard(context: AgentEventSocketContext, raw: any, connection: QueueConnection): Promise<any> {
  if (!context.scriptId) throw new GenerationQueueError(422, "AGENT_SCRIPT_REQUIRED", "Production Agent 必须选择剧本");
  return connection.transaction(async (trx) => {
    const latestTrack = await trx("o_videoTrack").max({ id: "id" }).first();
    const trackId = Math.max(Date.now(), Number(latestTrack?.id ?? 0) + 1);
    await trx("o_videoTrack").insert({ id: trackId, scriptId: context.scriptId, projectId: context.projectId });
    const [id] = await trx("o_storyboard").insert({
      prompt: raw?.prompt ?? "", duration: Number(raw?.duration ?? 0), state: "未生成", track: String(raw?.track ?? ""),
      trackId, videoDesc: String(raw?.videoDesc ?? ""), shouldGenerateImage: raw?.shouldGenerateImage === true || raw?.shouldGenerateImage === "true" ? 1 : 0,
      scriptId: context.scriptId, projectId: context.projectId, createTime: Date.now(),
    });
    const assetIds: number[] = [...new Set<number>((Array.isArray(raw?.associateAssetsIds) ? raw.associateAssetsIds : []).map(Number))];
    if (assetIds.length) {
      const valid = await trx("o_assets").where({ projectId: context.projectId }).whereIn("id", assetIds).select("id");
      if (valid.length !== assetIds.length) throw new GenerationQueueError(404, "ASSET_NOT_FOUND", "部分关联资产不存在或不属于当前项目");
      await trx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ storyboardId: Number(id), assetId })));
    }
    return { id: Number(id), trackId };
  });
}

async function handleAgentCallback(event: string, data: any, context: AgentEventSocketContext, connection: QueueConnection): Promise<unknown> {
  if (event === "getPlanData") return getPlanData(context, connection);
  if (event === "getFlowData") return getFlowData(context, connection);
  if (event === "addDeriveAsset") return addDeriveAsset(context, data, connection);
  if (event === "delDeriveAsset") return delDeriveAsset(context, data, connection);
  if (event === "addStoryboard") return addStoryboard(context, data, connection);
  if (event === "generateDeriveAsset") return enqueueAssetImageJobs(context.actor, { projectId: context.projectId, assetIds: data?.ids ?? [] }, `${context.requestId}:derive`, connection);
  if (event === "generateStoryboard") {
    if (!context.scriptId) throw new GenerationQueueError(422, "AGENT_SCRIPT_REQUIRED", "Production Agent 必须选择剧本");
    return enqueueStoryboardImageJobs(context.actor, { projectId: context.projectId, scriptId: context.scriptId, storyboardIds: data?.ids ?? [], compulsory: true }, `${context.requestId}:storyboard`, connection);
  }
  throw new GenerationQueueError(422, "AGENT_CALLBACK_UNSUPPORTED", `Agent callback 事件不受支持: ${event}`);
}

export class PersistentAgentEventSocket {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    public readonly jobId: number,
    private readonly connection: QueueConnection,
    private readonly context?: AgentEventSocketContext,
  ) {}

  emit(event: string, data?: unknown, callback?: (...args: any[]) => void): boolean {
    if (callback) {
      this.pending = this.pending.then(async () => {
        if (!this.context) throw new GenerationQueueError(500, "AGENT_CALLBACK_CONTEXT_MISSING", "Agent callback 缺少后端运行上下文");
        try {
          callback(await handleAgentCallback(event, data, this.context, this.connection));
        } catch (error: any) {
          callback({ error: error?.message ?? "Agent callback 执行失败", code: error?.code ?? "AGENT_CALLBACK_FAILED" });
          throw error;
        }
      });
    } else {
      this.pending = this.pending.then(() => appendAgentJobEvent(this.jobId, event, data, this.connection));
    }
    return true;
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

export async function enqueueAgentChatJob(
  actor: AuthUser,
  input: EnqueueAgentChatInput,
  requestId: string,
  connection?: QueueConnection,
): Promise<QueuedWorkflowItem> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new GenerationQueueError(422, "AGENT_PROMPT_REQUIRED", "请输入 Agent 任务内容");
  if (!input.isolationKey.startsWith(`${input.projectId}:`)) {
    throw new GenerationQueueError(422, "AGENT_ISOLATION_INVALID", "Agent 隔离标识无效");
  }
  const targetId = input.agentType === "production_agent" ? Number(input.scriptId) : input.projectId;
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new GenerationQueueError(422, "AGENT_SCRIPT_REQUIRED", "Production Agent 必须选择剧本");
  }
  const resolved = await resolveConnection(connection);
  if (input.agentType === "production_agent") {
    const script = await resolved("o_script").where({ id: targetId, projectId: input.projectId }).first();
    if (!script) throw new GenerationQueueError(404, "SCRIPT_NOT_FOUND", "剧本不存在或不属于当前项目");
  }
  const job = await enqueueGeneration(actor, {
    projectId: input.projectId,
    sourceTaskId: input.agentType === "production_agent" ? targetId : undefined,
    handlerKey: "core.text",
    taskType: "text",
    payload: {
      operation: input.agentType,
      projectId: input.projectId,
      targetId,
      ...(input.agentType === "production_agent" ? { scriptId: targetId } : {}),
      model: "universalAi",
      prompt,
      isolationKey: input.isolationKey,
      thinkLevel: Math.max(0, Math.min(3, Math.trunc(input.thinkLevel))),
    },
    idempotencyKey: `agent:${input.agentType}:${requestId}:${targetId}`,
  }, resolved);
  return { jobId: job.id, targetId, status: job.status };
}

async function defaultScriptRunner(runtime: AgentRuntime): Promise<void> {
  const [{ default: ResTool }, agent] = await Promise.all([
    import("@/socket/resTool"),
    import("@/agents/scriptAgent/index"),
  ]);
  const resTool = new ResTool(runtime.socket as any, { projectId: runtime.payload.projectId });
  const msg = resTool.newMessage("assistant", "统筹");
  await agent.runDecisionAI({
    socket: runtime.socket as any,
    isolationKey: runtime.payload.isolationKey,
    text: runtime.payload.prompt,
    userMessageTime: new Date(msg.datetime).getTime() - 1,
    abortSignal: runtime.context.signal,
    resTool,
    msg,
    thinkConfig: { think: runtime.payload.thinkLevel > 0, thinlLevel: runtime.payload.thinkLevel as 0 | 1 | 2 | 3 },
  });
}

async function defaultProductionRunner(runtime: AgentRuntime): Promise<void> {
  const [{ default: ResTool }, agent] = await Promise.all([
    import("@/socket/resTool"),
    import("@/agents/productionAgent/index"),
  ]);
  if (runtime.payload.operation !== "production_agent") throw new Error("Production Agent payload 无效");
  const resTool = new ResTool(runtime.socket as any, { projectId: runtime.payload.projectId, scriptId: runtime.payload.scriptId });
  const msg = resTool.newMessage("assistant", "视频策划");
  await agent.runDecisionAI({
    socket: runtime.socket as any,
    isolationKey: runtime.payload.isolationKey,
    text: runtime.payload.prompt,
    userMessageTime: new Date(msg.datetime).getTime() - 1,
    abortSignal: runtime.context.signal,
    resTool,
    msg,
    thinkConfig: { think: runtime.payload.thinkLevel > 0, thinlLevel: runtime.payload.thinkLevel as 0 | 1 | 2 | 3 },
  });
}

export async function executeQueuedAgent(
  payload: AgentPayload,
  context: GenerationExecutionContext,
  dependencies: ExecuteQueuedAgentDependencies = {},
): Promise<GenerationExecutionResult<{ agentType: AgentPayload["operation"]; eventCount: number }>> {
  const connection = await resolveConnection(dependencies.connection);
  const before = await listAgentJobEvents(context.jobId, 0, connection);
  const user = await connection("o_user").where({ id: context.ownerUserId }).select("id", "name", "role", "groupId").first();
  if (!user) throw new GenerationQueueError(404, "AGENT_ACTOR_NOT_FOUND", "Agent 任务所属用户不存在");
  const socket = new PersistentAgentEventSocket(context.jobId, connection, {
    actor: { id: Number(user.id), name: String(user.name), role: user.role, groupId: user.groupId == null ? null : Number(user.groupId) },
    projectId: payload.projectId,
    ...(payload.operation === "production_agent" ? { scriptId: payload.scriptId } : {}),
    requestId: `agent-job:${context.jobId}`,
  });
  await context.setProviderRequestId(`agent:${payload.operation}:${context.jobId}`);
  const runtime = { payload, context, socket };
  if (payload.operation === "script_agent") {
    await (dependencies.runScriptAgent ?? defaultScriptRunner)(runtime);
  } else {
    await (dependencies.runProductionAgent ?? defaultProductionRunner)(runtime);
  }
  await socket.flush();
  const after = await listAgentJobEvents(context.jobId, before.length, connection);
  return {
    result: { agentType: payload.operation, eventCount: after.length },
    metering: {
      providerId: null,
      modelId: payload.model,
      units: {},
      estimatedCost: null,
      currency: null,
      pricingSnapshot: {},
      providerRequestId: null,
    },
  };
}
