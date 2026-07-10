import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/scriptAgent/index";
import ResTool from "@/socket/resTool";
import { authenticateSocketProject, isSocketIsolationKeyValid } from "@/socket/auth";

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const token = socket.handshake.auth.token;
    const projectId = Number(socket.handshake.auth.projectId);
    if (!token || !(await authenticateSocketProject(token, projectId))) {
      socket.emit("error", { message: "项目不存在或当前账号无权访问" });
      socket.disconnect();
      return;
    }
    const isolationKey = socket.handshake.auth.isolationKey;
    if (!isSocketIsolationKeyValid(projectId, isolationKey)) {
      socket.emit("error", { message: "项目不存在或当前账号无权访问" });
      socket.disconnect();
      return;
    }

    console.log("[scriptAgent] 已连接:", socket.id);

    const resTool = new ResTool(socket, {
      projectId,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "统筹");
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
          console.error("[scriptAgent] chat error:", u.error(err).message);
          msg.error(u.error(err).message)
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
      console.log("[scriptAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[scriptAgent] 已断开连接:", socket.id);
  });
};
