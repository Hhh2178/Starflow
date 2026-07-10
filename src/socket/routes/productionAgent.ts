import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";
import { authenticateSocketProject, isSocketIsolationKeyValid } from "@/socket/auth";

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    let projectId = Number(socket.handshake.auth.projectId);
    const initialScriptId = socket.handshake.auth.scriptId == null ? undefined : Number(socket.handshake.auth.scriptId);
    if (!token || !(await authenticateSocketProject(token, projectId, initialScriptId))) {
      socket.emit("error", { message: "项目不存在或当前账号无权访问" });
      socket.disconnect();
      return;
    }
    let isolationKey = socket.handshake.auth.isolationKey;
    if (!isSocketIsolationKeyValid(projectId, isolationKey)) {
      socket.emit("error", { message: "项目不存在或当前账号无权访问" });
      socket.disconnect();
      return;
    }

    console.log("[productionAgent] 已连接:", socket.id);

    let resTool = new ResTool(socket, {
      projectId,
      scriptId: initialScriptId,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("updateContext", async (data: { isolationKey: string; projectId: number; scriptId: number }, callback) => {
      if (!(await authenticateSocketProject(token, data.projectId, data.scriptId)) || !isSocketIsolationKeyValid(data.projectId, data.isolationKey)) {
        socket.emit("error", { message: "项目不存在或当前账号无权访问" });
        callback?.({ success: false, message: "项目不存在或当前账号无权访问" });
        return;
      }
      projectId = data.projectId;
      isolationKey = data.isolationKey;
      resTool = new ResTool(socket, {
        projectId: data.projectId,
        scriptId: data.scriptId,
      });
      console.log("[productionAgent] 上下文已更新:", isolationKey);
      callback?.({ success: true });
    });

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "视频策划");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
      };

      try {
        await agent.runDecisionAI(ctx);
      } catch (err: any) {
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          console.error("[productionAgent] chat error:", u.error(err).message);
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[productionAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[productionAgent] 已断开连接:", socket.id);
  });
};
