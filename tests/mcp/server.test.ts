import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest, runMcpServer } from "../../src/mcp/server.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";

describe("Cyberdeck MCP server", () => {
  it("advertises semantic Cyberdeck tools", async () => {
    const response = await handleMcpRequest({ request: vi.fn() }, ACTOR, {
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
    const response = await handleMcpRequest({ request: request as never }, ACTOR, {
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "cyberdeck_threads_list", arguments: {} },
    });
    expect(request).toHaveBeenCalledWith("agent.thread.list", { actorSessionId: ACTOR });
    expect(response).toMatchObject({ id: "call-1", result: { content: [{ type: "text" }] } });
  });

  it("reads one semantic thread event per page by default", async () => {
    const request = vi.fn(async () => ({ events: [], nextCursor: 0 }));
    const sessionId = "22222222-2222-4222-8222-222222222222";
    await handleMcpRequest({ request: request as never }, ACTOR, {
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
    const response = await handleMcpRequest({ request }, ACTOR, {
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
    await handleMcpRequest({ request: request as never }, ACTOR, {
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
    const response = await handleMcpRequest({ request: vi.fn() }, ACTOR, {
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
    await handleMcpRequest({ request: request as never }, ACTOR, {
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
    const response = await handleMcpRequest({
      request: vi.fn(async () => {
        throw Object.assign(new Error("Broker connection closed"), { code: "BROKER_DISCONNECTED" });
      }) as never,
    }, ACTOR, {
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
    const served = runMcpServer({ request: request as never }, ACTOR, input, output);

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
    await handleMcpRequest({ request: request as never }, ACTOR, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "cyberdeck_workers_start", arguments: { workers } },
    });
    expect(request).toHaveBeenCalledWith("agent.worker.startMany", { actorSessionId: ACTOR, workers });
  });
});
