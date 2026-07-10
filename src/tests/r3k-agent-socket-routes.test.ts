import assert from "node:assert/strict";
import type { AuthUser } from "@/types/auth";

type Listener = (...args: any[]) => unknown;

class FakeSocket {
  id = "socket-1";
  disconnected = false;
  listeners = new Map<string, Listener>();
  emitted: Array<{ event: string; data: any }> = [];

  constructor(public handshake: { auth: Record<string, unknown> }) {}

  on(event: string, listener: Listener) { this.listeners.set(event, listener); return this; }
  emit(event: string, data?: unknown) { this.emitted.push({ event, data }); return true; }
  disconnect() { this.disconnected = true; }
  async receive(event: string, ...args: any[]) { return this.listeners.get(event)?.(...args); }
}

class FakeNamespace {
  connection?: Listener;
  on(event: string, listener: Listener) { if (event === "connection") this.connection = listener; return this; }
  async connect(socket: FakeSocket) { await this.connection?.(socket); }
}

const actor: AuthUser = { id: 3, name: "creator-a", role: "creator", groupId: 101 };

async function main() {
  const [scriptModule, productionModule] = await Promise.all([
    import("@/socket/routes/scriptAgent"),
    import("@/socket/routes/productionAgent"),
  ]);
  const createScriptRoute = (scriptModule as any).createScriptAgentSocketRoute;
  const createProductionRoute = (productionModule as any).createProductionAgentSocketRoute;
  assert.equal(typeof createScriptRoute, "function", "script Agent route must expose a testable queued socket factory");
  assert.equal(typeof createProductionRoute, "function", "production Agent route must expose a testable queued socket factory");

  const calls: Array<{ kind: string; actor: AuthUser; value: any }> = [];
  const dependencies = {
    authenticate: async (_token: string, projectId: number, scriptId?: number) => projectId === 1001 && (scriptId == null || scriptId === 801) ? actor : null,
    enqueue: async (authenticatedActor: AuthUser, input: any, requestId: string) => {
      calls.push({ kind: "enqueue", actor: authenticatedActor, value: { input, requestId } });
      return { jobId: input.agentType === "script_agent" ? 41 : 42, targetId: input.scriptId ?? input.projectId, status: "queued" };
    },
    cancel: async (authenticatedActor: AuthUser, jobId: number) => {
      calls.push({ kind: "cancel", actor: authenticatedActor, value: jobId });
      return { id: jobId, status: "cancelled" };
    },
    replay: async (authenticatedActor: AuthUser, scope: any) => {
      calls.push({ kind: "replay", actor: authenticatedActor, value: scope });
      if (scope.projectId !== 1001 || (scope.scriptId != null && scope.scriptId !== 801)) throw new Error("JOB_NOT_FOUND");
      return [{ sequence: 3, event: "message:update", data: { id: "m1", status: "complete" }, createdAt: 123 }];
    },
  };

  const scriptNamespace = new FakeNamespace();
  createScriptRoute(scriptNamespace as any, dependencies);
  const scriptSocket = new FakeSocket({ auth: { token: "valid", projectId: 1001, isolationKey: "1001:scriptAgent", jobId: 40, afterSequence: 2, user: { id: 999 } } });
  await scriptNamespace.connect(scriptSocket);
  assert.equal(calls[0].kind, "replay");
  assert.equal(calls[0].actor.id, 3);
  assert.deepEqual(calls[0].value, { jobId: 40, projectId: 1001, afterSequence: 2 });
  assert.equal(scriptSocket.emitted.some((item) => item.event === "agentJobEvent" && item.data.sequence === 3), true);

  let scriptAck: any;
  await scriptSocket.receive("chat", { content: "生成骨架", requestId: "req-script", userId: 999, groupId: 999 }, (value: unknown) => { scriptAck = value; });
  assert.deepEqual(scriptAck, { jobId: 41, targetId: 1001, status: "queued" });
  assert.deepEqual(scriptSocket.emitted.at(-1), { event: "agent:queued", data: scriptAck });
  assert.equal(calls.find((call) => call.kind === "enqueue")?.actor.id, 3);

  let stopAck: any;
  await scriptSocket.receive("stop", { jobId: 41 }, (value: unknown) => { stopAck = value; });
  assert.deepEqual(stopAck, { jobId: 41, targetId: 1001, status: "cancelled" });
  assert.equal(calls.find((call) => call.kind === "cancel")?.actor.id, 3);

  const productionNamespace = new FakeNamespace();
  createProductionRoute(productionNamespace as any, dependencies);
  const wrongTaskSocket = new FakeSocket({ auth: { token: "valid", projectId: 1001, scriptId: 801, isolationKey: "1001:productionAgent:999" } });
  await productionNamespace.connect(wrongTaskSocket);
  assert.equal(wrongTaskSocket.disconnected, true, "production isolation key must match the authenticated script task");
  const productionSocket = new FakeSocket({ auth: { token: "valid", projectId: 1001, scriptId: 801, isolationKey: "1001:productionAgent:801" } });
  await productionNamespace.connect(productionSocket);
  let contextAck: any;
  await productionSocket.receive("updateContext", { isolationKey: "1001:productionAgent:801", projectId: 1001, scriptId: 801, userId: 999 }, (value: unknown) => { contextAck = value; });
  assert.deepEqual(contextAck, { success: true });
  await productionSocket.receive("updateThinkConfig", { think: true, thinlLevel: 2, userId: 999 });
  let productionAck: any;
  await productionSocket.receive("chat", { content: "生成分镜", requestId: "req-production", groupId: 999 }, (value: unknown) => { productionAck = value; });
  assert.deepEqual(productionAck, { jobId: 42, targetId: 801, status: "queued" });
  const productionCall = calls.filter((call) => call.kind === "enqueue").at(-1)!;
  assert.equal(productionCall.actor.id, 3);
  assert.equal(productionCall.value.input.thinkLevel, 2);

  let replayEvents: any;
  await productionSocket.receive("agent:events", { jobId: 42, afterSequence: 2 }, (value: unknown) => { replayEvents = value; });
  assert.deepEqual(replayEvents.map((event: any) => event.sequence), [3]);
  let replayError: any;
  await productionSocket.receive("agent:events", { jobId: 42, afterSequence: 0, projectId: 999, scriptId: 999 }, (value: unknown) => { replayError = value; });
  assert.equal(replayError.success, false);
  assert.equal(productionSocket.emitted.at(-1)?.event, "error");
}

main().then(
  () => { console.log("R3K Agent socket route tests passed"); process.exit(0); },
  (error) => { console.error(error); process.exit(1); },
);
