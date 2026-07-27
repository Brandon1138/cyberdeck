import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  handleMcpRequest,
  resolveLaunchConversationId,
  runMcpServer,
  type McpBrokerTransport,
  type McpServerContext,
} from "../../src/mcp/server.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const SOCKET = "/tmp/cyberdeck-test.sock";

function context(
  transport?: McpBrokerTransport,
  identity: Partial<McpServerContext["identity"]> = {},
  brokerUnavailable?: string,
): McpServerContext {
  return {
    identity: { actorSessionId: ACTOR, brokerSocketPath: SOCKET, ...identity },
    ...(transport === undefined ? {} : { transport }),
    ...(brokerUnavailable === undefined ? {} : { brokerUnavailable }),
  };
}

function payload(response: Record<string, unknown> | undefined, index = 0): Record<string, unknown> {
  const content = (response?.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[index]!.text) as Record<string, unknown>;
}

describe("Cyberdeck MCP server", () => {
  it("advertises semantic Cyberdeck tools", async () => {
    const response = await handleMcpRequest(context({ request: vi.fn() }), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(response).toMatchObject({
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "cyberdeck_threads_list" }),
          expect.objectContaining({ name: "cyberdeck_thread_read" }),
          expect.objectContaining({ name: "cyberdeck_worker_start" }),
          expect.objectContaining({ name: "cyberdeck_workers_start" }),
          expect.objectContaining({ name: "cyberdeck_workers_wait" }),
          expect.objectContaining({ name: "cyberdeck_provider_capabilities" }),
          expect.objectContaining({ name: "cyberdeck_orchestrator_inspect" }),
          expect.objectContaining({ name: "cyberdeck_orchestrator_stop" }),
          expect.objectContaining({ name: "cyberdeck_orchestrator_force_stop" }),
        ]),
      },
    });
    const tools = (response?.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, { enum?: string[]; maxItems?: number }> } }> }).tools;
    const workerStart = tools.find(({ name }) => name === "cyberdeck_worker_start");
    expect(workerStart?.inputSchema.properties?.provider?.enum).toEqual([
      "codex",
      "claude",
      "cursor",
      "antigravity",
    ]);
    expect(workerStart?.inputSchema.properties).toHaveProperty("effort");
    expect(workerStart?.inputSchema.properties?.approvalMode?.enum).toEqual(["prompt", "auto"]);
    expect(workerStart?.inputSchema.properties?.profile?.enum).toEqual(["scout"]);
    expect(workerStart?.inputSchema.properties).toHaveProperty("brief");
    expect((workerStart?.inputSchema.properties?.leasePolicy as { default?: string } | undefined)?.default)
      .toBeUndefined();
    const threadRead = tools.find(({ name }) => name === "cyberdeck_thread_read") as {
      inputSchema: { required?: string[]; properties?: { limit?: { maximum?: number; default?: number } } };
    } | undefined;
    expect(threadRead?.inputSchema.required).toContain("afterCursor");
    expect(threadRead?.inputSchema.properties?.limit?.maximum).toBe(100);
    expect(threadRead?.inputSchema.properties?.limit?.default).toBe(1);
    const workersStart = tools.find(({ name }) => name === "cyberdeck_workers_start");
    const workersWait = tools.find(({ name }) => name === "cyberdeck_workers_wait");
    expect(workersStart?.inputSchema.properties?.workers?.maxItems).toBe(64);
    expect(workersWait?.inputSchema.properties?.targets?.maxItems).toBe(64);
  });

  it("adds the bound actor identity to every broker operation", async () => {
    const request = vi.fn(async () => [{ id: "worker" }]);
    const response = await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "cyberdeck_threads_list", arguments: {} },
    });
    expect(request).toHaveBeenCalledWith("agent.thread.list", { actorSessionId: ACTOR });
    expect(response).toMatchObject({ id: "call-1", result: { content: [{ type: "text" }] } });
  });

  it("routes generation-checked Orc inspection and stop requests through the broker", async () => {
    const request = vi.fn(async () => ({ outcome: "STOP_REQUESTED" }));
    const targetSessionId = "22222222-2222-4222-8222-222222222222";
    await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "inspect-orc",
      method: "tools/call",
      params: {
        name: "cyberdeck_orchestrator_inspect",
        arguments: { targetSessionId },
      },
    });
    await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "stop-orc",
      method: "tools/call",
      params: {
        name: "cyberdeck_orchestrator_stop",
        arguments: { targetSessionId, expectedGeneration: 4, reason: "stale controller" },
      },
    });

    expect(request).toHaveBeenNthCalledWith(1, "agent.orchestrator.inspect", {
      actorSessionId: ACTOR,
      targetSessionId,
    });
    expect(request).toHaveBeenNthCalledWith(2, "agent.orchestrator.stop", {
      actorSessionId: ACTOR,
      targetSessionId,
      expectedGeneration: 4,
      reason: "stale controller",
    });
  });

  it("reads one semantic thread event per page by default", async () => {
    const request = vi.fn(async () => ({ events: [], nextCursor: 0 }));
    const sessionId = "22222222-2222-4222-8222-222222222222";
    await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "thread-read",
      method: "tools/call",
      params: {
        name: "cyberdeck_thread_read",
        arguments: { sessionId, afterCursor: 0 },
      },
    });
    expect(request).toHaveBeenCalledWith("agent.thread.read", {
      actorSessionId: ACTOR,
      sessionId,
      afterCursor: 0,
      limit: 1,
    });
  });

  it("returns authoritative provider capabilities without a broker round trip", async () => {
    const request = vi.fn();
    const response = await handleMcpRequest(context({ request }), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "cyberdeck_provider_capabilities", arguments: { provider: "codex" } },
    });
    const text = ((response?.result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(JSON.parse(text)).toEqual([expect.objectContaining({
      provider: "codex",
      models: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"],
    })]);
    expect(request).not.toHaveBeenCalled();
  });

  it("routes one blocking wait request for multiple workers", async () => {
    const request = vi.fn(async () => ({ timedOut: false, results: [] }));
    await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "cyberdeck_workers_wait",
        arguments: {
          targets: [{ sessionId: "22222222-2222-4222-8222-222222222222", completionTarget: 1 }],
        },
      },
    });
    expect(request).toHaveBeenCalledWith("agent.worker.wait", {
      actorSessionId: ACTOR,
      targets: [{ sessionId: "22222222-2222-4222-8222-222222222222", completionTarget: 1 }],
    });
  });

  it("advertises a bounded, projectable thread listing and a segmented wait", async () => {
    const response = await handleMcpRequest(context({ request: vi.fn() }), {
      jsonrpc: "2.0",
      id: "schema",
      method: "tools/list",
    });
    const tools = (response?.result as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: { properties?: Record<string, { enum?: string[]; default?: unknown; maximum?: number; type?: string }> };
      }>;
    }).tools;
    const list = tools.find(({ name }) => name === "cyberdeck_threads_list");
    expect(list?.inputSchema.properties?.view?.enum).toEqual(["status", "full"]);
    expect(list?.inputSchema.properties?.view?.default).toBe("status");
    expect(list?.inputSchema.properties?.limit?.maximum).toBe(200);
    expect(list?.inputSchema.properties?.cursor?.type).toBe("integer");
    const wait = tools.find(({ name }) => name === "cyberdeck_workers_wait");
    expect(wait?.inputSchema.properties?.timeoutSeconds?.maximum).toBe(600);
    expect(wait?.inputSchema.properties).toHaveProperty("waitId");
    expect(wait?.description).toContain("90s");
    expect(wait?.description).toContain("incomplete");
  });

  it("forwards paging and projection arguments to the broker listing", async () => {
    const request = vi.fn(async () => ({ view: "status", threads: [], total: 0 }));
    await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "list",
      method: "tools/call",
      params: { name: "cyberdeck_threads_list", arguments: { view: "full", limit: 10, cursor: 20 } },
    });
    expect(request).toHaveBeenCalledWith("agent.thread.list", {
      actorSessionId: ACTOR,
      view: "full",
      limit: 10,
      cursor: 20,
    });
  });

  it("reports a control-plane failure as its own class, not as a worker outcome", async () => {
    const response = await handleMcpRequest(context({
      request: vi.fn(async () => {
        throw Object.assign(new Error("Broker connection closed"), { code: "BROKER_DISCONNECTED" });
      }) as never,
    }), {
      jsonrpc: "2.0",
      id: "failure",
      method: "tools/call",
      params: {
        name: "cyberdeck_workers_wait",
        arguments: { targets: [{ sessionId: "22222222-2222-4222-8222-222222222222", completionTarget: 1 }] },
      },
    });
    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      failure: { kind: "control-plane", code: "BROKER_DISCONNECTED" },
      workerStateKnown: false,
      guidance: expect.stringContaining("cyberdeck_threads_list"),
      // The identity contract rides along on the same payload: the raw broker code says what the
      // control plane reported, the mapped code and remedy say what this agent should do next.
      error: {
        code: "CYBERDECK_BROKER_UNREACHABLE",
        actorSessionId: ACTOR,
        remedy: expect.any(String),
      },
    });
  });

  it("answers a thread listing while a worker wait is still blocking the same stdio pipe", async () => {
    let releaseWait = () => {};
    const request = vi.fn(async (method: string) => {
      if (method !== "agent.worker.wait") return { view: "status", threads: [], total: 0 };
      await new Promise<void>((resolve) => { releaseWait = resolve; });
      return { timedOut: false, results: [] };
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: Array<Record<string, unknown>> = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim() !== "") responses.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const served = runMcpServer(context({ request: request as never }), input, output);

    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "wait",
      method: "tools/call",
      params: {
        name: "cyberdeck_workers_wait",
        arguments: { targets: [{ sessionId: "22222222-2222-4222-8222-222222222222", completionTarget: 1 }] },
      },
    })}\n`);
    input.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "list",
      method: "tools/call",
      params: { name: "cyberdeck_threads_list", arguments: {} },
    })}\n`);

    await vi.waitFor(() => expect(responses.map(({ id }) => id)).toContain("list"));
    expect(responses.map(({ id }) => id)).not.toContain("wait");

    releaseWait();
    await vi.waitFor(() => expect(responses.map(({ id }) => id)).toContain("wait"));
    input.end();
    await served;
  });

  it("routes one compact batch-start request", async () => {
    const request = vi.fn(async () => []);
    const workers = [{
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "low",
      cwd: "/repo",
      prompt: "Ping",
      name: "sol-ping",
    }];
    await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "cyberdeck_workers_start", arguments: { workers } },
    });
    expect(request).toHaveBeenCalledWith("agent.worker.startMany", { actorSessionId: ACTOR, workers });
  });

  it("reads the live conversation identity Claude Code exports to the subprocess", () => {
    expect(resolveLaunchConversationId({ CLAUDE_CODE_SESSION_ID: CONVERSATION })).toBe(CONVERSATION);
    expect(resolveLaunchConversationId({ CLAUDE_CODE_SESSION_ID: "  " })).toBeUndefined();
    expect(resolveLaunchConversationId({})).toBeUndefined();
  });

  it("names the unreachable broker on every tool call instead of vanishing", async () => {
    const response = await handleMcpRequest(
      context(undefined, {}, `Cyberdeck broker is unreachable at ${SOCKET}: connect ENOENT`),
      {
        jsonrpc: "2.0",
        id: "unreachable",
        method: "tools/call",
        params: { name: "cyberdeck_threads_list", arguments: {} },
      },
    );
    expect(response).toMatchObject({ result: { isError: true } });
    expect(payload(response)).toMatchObject({
      error: {
        code: "CYBERDECK_BROKER_UNREACHABLE",
        message: expect.stringContaining("connect ENOENT"),
        remedy: expect.stringContaining("cyberdeck up"),
        actorSessionId: ACTOR,
        brokerSocketPath: SOCKET,
      },
    });
  });

  it("still advertises every tool while the broker is unreachable", async () => {
    const response = await handleMcpRequest(context(undefined, {}, "broker down"), {
      jsonrpc: "2.0",
      id: "list",
      method: "tools/list",
    });
    const tools = (response?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map(({ name }) => name)).toContain("cyberdeck_diagnose");
    expect(tools).toHaveLength(19);
  });

  it("distinguishes an orphaned scope from an unbound actor by code and remedy", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Scope fleet is now bound to session other"), {
        code: "ACTOR_BINDING_ORPHANED",
      });
    });
    const response = await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "orphaned",
      method: "tools/call",
      params: { name: "cyberdeck_threads_list", arguments: {} },
    });
    expect(response).toMatchObject({ result: { isError: true } });
    expect(payload(response)).toMatchObject({
      error: {
        code: "ACTOR_BINDING_ORPHANED",
        remedy: expect.stringContaining("widen this session's authority"),
      },
    });
  });

  it("maps a dropped broker connection to a named unreachable-broker failure", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Broker connection closed"), { code: "BROKER_DISCONNECTED" });
    });
    const response = await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "dropped",
      method: "tools/call",
      params: { name: "cyberdeck_threads_list", arguments: {} },
    });
    expect(payload(response)).toMatchObject({
      error: { code: "CYBERDECK_BROKER_UNREACHABLE" },
    });
  });

  it("reports conversation drift beside a successful result rather than swallowing it", async () => {
    const request = vi.fn(async () => []);
    const response = await handleMcpRequest(
      context({ request: request as never }, { launchConversationId: CONVERSATION }),
      {
        jsonrpc: "2.0",
        id: "drift",
        method: "tools/call",
        params: { name: "cyberdeck_threads_list", arguments: {} },
      },
    );
    // The grant is session-bound, so the call still runs; the drift is reported, not enforced.
    expect(request).toHaveBeenCalledWith("agent.thread.list", { actorSessionId: ACTOR });
    expect(response).not.toMatchObject({ result: { isError: true } });
    expect(payload(response, 1)).toMatchObject({
      cyberdeckWarning: {
        code: "CYBERDECK_CONVERSATION_DRIFTED",
        actorSessionId: ACTOR,
        liveConversationId: CONVERSATION,
      },
    });
  });

  it("omits the drift warning when the conversation still matches the bound session", async () => {
    const request = vi.fn(async () => []);
    const response = await handleMcpRequest(
      context({ request: request as never }, { launchConversationId: ACTOR }),
      {
        jsonrpc: "2.0",
        id: "no-drift",
        method: "tools/call",
        params: { name: "cyberdeck_threads_list", arguments: {} },
      },
    );
    expect((response?.result as { content: unknown[] }).content).toHaveLength(1);
  });

  it("diagnoses a healthy server against the live binding", async () => {
    const request = vi.fn(async () => ({
      actorSessionId: ACTOR,
      status: "bound",
      bound: true,
      familyKey: "fleet",
      familyHolderSessionId: ACTOR,
      capabilities: ["thread.list"],
      remedy: "No action required; this actor holds a live Cyberdeck orchestrator binding.",
    }));
    const response = await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "diagnose",
      method: "tools/call",
      params: { name: "cyberdeck_diagnose", arguments: {} },
    });
    expect(request).toHaveBeenCalledWith("agent.actor.describe", { actorSessionId: ACTOR });
    expect(payload(response)).toMatchObject({
      status: "healthy",
      actorSessionId: ACTOR,
      broker: { socketPath: SOCKET, reachable: true },
      actor: { status: "bound", familyKey: "fleet" },
      conversation: { matchesActorSession: true },
    });
  });

  it("diagnoses an orphaned scope and names the session that now holds it", async () => {
    const request = vi.fn(async () => ({
      actorSessionId: ACTOR,
      status: "orphaned",
      bound: false,
      familyKey: "fleet",
      familyHolderSessionId: "44444444-4444-4444-8444-444444444444",
      remedy: "Scope fleet is now bound to session 44444444-4444-4444-8444-444444444444",
    }));
    const response = await handleMcpRequest(
      context({ request: request as never }, { launchConversationId: CONVERSATION }),
      {
        jsonrpc: "2.0",
        id: "diagnose-orphaned",
        method: "tools/call",
        params: { name: "cyberdeck_diagnose", arguments: {} },
      },
    );
    expect(payload(response)).toMatchObject({
      status: "orphaned",
      conversation: { matchesActorSession: false, launchConversationId: CONVERSATION },
      actor: { familyHolderSessionId: "44444444-4444-4444-8444-444444444444" },
      remedy: expect.stringContaining("44444444-4444-4444-8444-444444444444"),
    });
  });

  it("tells a broker running an older build apart from a broker that is down", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Unknown method agent.actor.describe"), {
        code: "METHOD_NOT_FOUND",
      });
    });
    const response = await handleMcpRequest(context({ request: request as never }), {
      jsonrpc: "2.0",
      id: "diagnose-outdated",
      method: "tools/call",
      params: { name: "cyberdeck_diagnose", arguments: {} },
    });
    expect(payload(response)).toMatchObject({
      status: "broker-outdated",
      broker: { reachable: true, outdated: true },
      remedy: expect.stringContaining("restart without a rebuild"),
    });
  });

  it("answers cyberdeck_diagnose even when the broker cannot be reached", async () => {
    const response = await handleMcpRequest(
      context(undefined, {}, `Cyberdeck broker is unreachable at ${SOCKET}: connect ENOENT`),
      {
        jsonrpc: "2.0",
        id: "diagnose-down",
        method: "tools/call",
        params: { name: "cyberdeck_diagnose", arguments: {} },
      },
    );
    expect(response).not.toMatchObject({ result: { isError: true } });
    expect(payload(response)).toMatchObject({
      status: "broker-unreachable",
      broker: { reachable: false, error: expect.stringContaining("connect ENOENT") },
      actor: null,
      remedy: expect.stringContaining("cyberdeck up"),
    });
  });
});
