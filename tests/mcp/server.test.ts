import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../../src/mcp/server.js";

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
    const threadRead = tools.find(({ name }) => name === "cyberdeck_thread_read") as {
      inputSchema: { required?: string[]; properties?: { limit?: { maximum?: number } } };
    } | undefined;
    expect(threadRead?.inputSchema.required).toContain("afterCursor");
    expect(threadRead?.inputSchema.properties?.limit?.maximum).toBe(100);
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
