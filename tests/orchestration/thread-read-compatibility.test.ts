import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { agentMethods } from "../../src/broker/server/agent-methods.js";
import type { ThreadEvent, ThreadPageOptions } from "../../src/domain/thread.js";
import { handleMcpRequest } from "../../src/mcp/server.js";
import { readThreadPage } from "../../src/orchestration/thread-read-page.js";

const actorSessionId = randomUUID(), sessionId = randomUUID();
const event: ThreadEvent = { id: randomUUID(), sessionId, cursor: 1, kind: "turn", source: "provider",
  occurredAt: "2026-10-07T00:00:00.000Z", text: "x".repeat(20_000), data: {} };

it("returns the complete oversized event to an old-style request against the new broker", async () => {
  const read = vi.fn(async () => ({ events: [event], nextCursor: 1 }));
  const agentControl = { readThread: async (_actor: string, session: string, after: number, limit: number, options: ThreadPageOptions) =>
    readThreadPage({ read }, session, after, limit, options) };
  const result = await agentMethods["agent.thread.read"]!({ options: { agentControl } } as never, {} as never,
    { type: "request", id: 1, method: "agent.thread.read", params: { actorSessionId, sessionId, afterCursor: 0, limit: 1 } });
  expect(result).toEqual({ events: [event], nextCursor: 1 });
  expect(read).toHaveBeenCalledWith(sessionId, 0, 1);
});

it("explicitly opts the new MCP into pages and accepts complete events from an older broker", async () => {
  const request = vi.fn(async () => ({ events: [event], nextCursor: 1 }));
  const response = await handleMcpRequest({ identity: { actorSessionId }, transport: { request: request as never } },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cyberdeck_thread_read", arguments: { sessionId, afterCursor: 0 } } });
  expect(request).toHaveBeenCalledWith("agent.thread.read", { actorSessionId, sessionId, afterCursor: 0, limit: 1, maxBytes: 16 * 1024 });
  const result = response!.result as { content: Array<{ text: string }> };
  expect(JSON.parse(result.content[0]!.text)).toEqual({ events: [event], nextCursor: 1 });
});
