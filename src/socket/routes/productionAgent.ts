import type { Namespace, Socket } from "socket.io";
import type { AuthUser } from "@/types/auth";
import { authenticateSocketProject, isSocketIsolationKeyValid } from "@/socket/auth";
import { cancelGenerationJob } from "@/services/generationQueue";
import { enqueueAgentChatJob, listScopedAgentJobEvents } from "@/services/agentQueue";

function isProductionAgentIsolationKeyValid(projectId: number, scriptId: number | undefined, value: unknown): value is string {
  return scriptId != null && isSocketIsolationKeyValid(projectId, value) && value === `${projectId}:productionAgent:${scriptId}`;
}

interface ProductionAgentSocketDependencies {
  authenticate: (token: string, projectId: number, scriptId?: number) => Promise<AuthUser | null>;
  enqueue: typeof enqueueAgentChatJob;
  cancel: typeof cancelGenerationJob;
  replay: (actor: AuthUser, input: { jobId: number; projectId: number; scriptId?: number; afterSequence?: number }) => Promise<Array<{ sequence: number; event: string; data: unknown; createdAt: number }>>;
}

const defaultDependencies: ProductionAgentSocketDependencies = {
  authenticate: authenticateSocketProject,
  enqueue: enqueueAgentChatJob,
  cancel: cancelGenerationJob,
  replay: listScopedAgentJobEvents,
};

function socketError(socket: Socket, callback: ((value: unknown) => void) | undefined, error: any): void {
  const value = { success: false, code: error?.code ?? "AGENT_SOCKET_ERROR", message: error?.message ?? "Agent 请求失败" };
  socket.emit("error", value);
  callback?.(value);
}

export function createProductionAgentSocketRoute(nsp: Namespace, dependencies: ProductionAgentSocketDependencies = defaultDependencies): void {
  nsp.on("connection", async (socket: Socket) => {
    const token = String(socket.handshake.auth.token ?? "");
    let projectId = Number(socket.handshake.auth.projectId);
    let scriptId = socket.handshake.auth.scriptId == null ? undefined : Number(socket.handshake.auth.scriptId);
    let isolationKey = socket.handshake.auth.isolationKey;
    let actor = await dependencies.authenticate(token, projectId, scriptId);
    if (!actor || !isProductionAgentIsolationKeyValid(projectId, scriptId, isolationKey)) {
      socket.emit("error", { message: "项目不存在或当前账号无权访问" });
      socket.disconnect();
      return;
    }

    let thinkLevel = 0;
    let lastJobId: number | undefined;
    const loadEvents = async (data: any) => {
      if ((data?.projectId != null && Number(data.projectId) !== projectId) || (data?.scriptId != null && Number(data.scriptId) !== scriptId)) {
        throw new Error("任务不存在或不属于当前剧本");
      }
      const jobId = Number(data?.jobId);
      const events = await dependencies.replay(actor!, { jobId, projectId, scriptId, afterSequence: Number(data?.afterSequence ?? 0) });
      return { jobId, events };
    };
    const replay = async (data: any, callback?: (value: unknown) => void) => {
      try {
        const { jobId, events } = await loadEvents(data);
        for (const event of events) socket.emit("agentJobEvent", { jobId, ...event });
        callback?.({ success: true, jobId, count: events.length });
      } catch (error) {
        socketError(socket, callback, error);
      }
    };

    if (socket.handshake.auth.jobId != null) {
      await replay({ jobId: socket.handshake.auth.jobId, afterSequence: socket.handshake.auth.afterSequence });
    }
    socket.on("replay", replay);
    socket.on("agent:events", async (data: any, callback?: (value: unknown) => void) => {
      try { callback?.((await loadEvents(data)).events); } catch (error) { socketError(socket, callback, error); }
    });
    socket.on("updateContext", async (data: any, callback?: (value: unknown) => void) => {
      const nextProjectId = Number(data?.projectId);
      const nextScriptId = Number(data?.scriptId);
      const nextActor = await dependencies.authenticate(token, nextProjectId, nextScriptId);
      if (!nextActor || !isProductionAgentIsolationKeyValid(nextProjectId, nextScriptId, data?.isolationKey)) {
        socketError(socket, callback, new Error("项目不存在或当前账号无权访问"));
        return;
      }
      actor = nextActor;
      projectId = nextProjectId;
      scriptId = nextScriptId;
      isolationKey = data.isolationKey;
      callback?.({ success: true });
    });
    socket.on("chat", async (data: any, callback?: (value: unknown) => void) => {
      try {
        const result = await dependencies.enqueue(actor!, {
          agentType: "production_agent",
          projectId,
          scriptId,
          prompt: String(data?.content ?? ""),
          isolationKey,
          thinkLevel,
        }, String(data?.requestId ?? `${socket.id}:${Date.now()}`));
        lastJobId = result.jobId;
        callback?.(result);
        socket.emit("agent:queued", result);
      } catch (error) {
        socketError(socket, callback, error);
      }
    });
    socket.on("updateThinkConfig", (data: any) => {
      thinkLevel = Math.max(0, Math.min(3, Math.trunc(Number(data?.thinlLevel ?? 0))));
    });
    socket.on("stop", async (data?: any, callback?: (value: unknown) => void) => {
      try {
        if (typeof data === "function") { callback = data; data = undefined; }
        const jobId = Number(data?.jobId ?? lastJobId);
        const job = await dependencies.cancel(actor!, jobId);
        const result = { jobId: Number(job.id), targetId: Number(scriptId), status: job.status };
        callback?.(result);
        socket.emit("agentJobCancelled", result);
      } catch (error) {
        socketError(socket, callback, error);
      }
    });
  });
}

export default (nsp: Namespace) => createProductionAgentSocketRoute(nsp);
