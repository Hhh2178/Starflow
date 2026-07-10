import type { Namespace, Socket } from "socket.io";
import type { AuthUser } from "@/types/auth";
import { authenticateSocketProject, isSocketIsolationKeyValid } from "@/socket/auth";
import { cancelGenerationJob } from "@/services/generationQueue";
import { enqueueAgentChatJob, listScopedAgentJobEvents } from "@/services/agentQueue";

function isScriptAgentIsolationKeyValid(projectId: number, value: unknown): value is string {
  return isSocketIsolationKeyValid(projectId, value) && value === `${projectId}:scriptAgent`;
}

interface ScriptAgentSocketDependencies {
  authenticate: (token: string, projectId: number) => Promise<AuthUser | null>;
  enqueue: typeof enqueueAgentChatJob;
  cancel: typeof cancelGenerationJob;
  replay: (actor: AuthUser, input: { jobId: number; projectId: number; afterSequence?: number }) => Promise<Array<{ sequence: number; event: string; data: unknown; createdAt: number }>>;
}

const defaultDependencies: ScriptAgentSocketDependencies = {
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

export function createScriptAgentSocketRoute(nsp: Namespace, dependencies: ScriptAgentSocketDependencies = defaultDependencies): void {
  nsp.on("connection", async (socket: Socket) => {
    const token = String(socket.handshake.auth.token ?? "");
    const projectId = Number(socket.handshake.auth.projectId);
    const isolationKey = socket.handshake.auth.isolationKey;
    const actor = await dependencies.authenticate(token, projectId);
    if (!actor || !isScriptAgentIsolationKeyValid(projectId, isolationKey)) {
      socket.emit("error", { message: "项目不存在或当前账号无权访问" });
      socket.disconnect();
      return;
    }

    let thinkLevel = 0;
    let lastJobId: number | undefined;
    const loadEvents = async (data: any) => {
      if (data?.projectId != null && Number(data.projectId) !== projectId) throw new Error("任务不存在或不属于当前项目");
      const jobId = Number(data?.jobId);
      const events = await dependencies.replay(actor, { jobId, projectId, afterSequence: Number(data?.afterSequence ?? 0) });
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
    socket.on("chat", async (data: any, callback?: (value: unknown) => void) => {
      try {
        const result = await dependencies.enqueue(actor, {
          agentType: "script_agent",
          projectId,
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
        const job = await dependencies.cancel(actor, jobId);
        const result = { jobId: Number(job.id), targetId: projectId, status: job.status };
        callback?.(result);
        socket.emit("agentJobCancelled", result);
      } catch (error) {
        socketError(socket, callback, error);
      }
    });
  });
}

export default (nsp: Namespace) => createScriptAgentSocketRoute(nsp);
