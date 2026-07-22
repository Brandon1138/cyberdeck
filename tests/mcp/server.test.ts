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
        ]),
      },
    });
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
});
