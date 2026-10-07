import { expect, it, vi } from "vitest";
import { handleMcpRequest } from "../../src/mcp/server.js";

it("reads fresh capabilities for each catalog and keeps recovery tools on unavailable brokers", async () => {
  let capabilities = ["thread.list"];
  const request = vi.fn(async (method: string) => {
    if (method === "agent.actor.describe") return { status: "bound", capabilities };
    throw Object.assign(new Error("Capability denied"), { code: "CAPABILITY_DENIED" });
  });
  const context = { identity: { actorSessionId: "11111111-1111-4111-8111-111111111111" }, transport: { request: request as never } };
  const list = async () => (await handleMcpRequest(context, { jsonrpc: "2.0", id: 1, method: "tools/list" }))!.result as { tools: Array<{ name: string }> };
  const initial = await list();
  expect(initial.tools.map((tool) => tool.name)).toContain("cyberdeck_threads_list");
  expect(initial.tools.map((tool) => tool.name)).not.toContain("cyberdeck_thread_read");
  expect(initial.tools.map((tool) => tool.name)).toContain("cyberdeck_diagnose");
  capabilities = ["thread.read"];
  expect((await list()).tools.map((tool) => tool.name)).toContain("cyberdeck_thread_read");
  // Hidden tools can still be named by an old harness index; authorization remains broker-side.
  const denied = await handleMcpRequest(context, { jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "cyberdeck_worker_start", arguments: {} } });
  expect((denied!.result as { isError: boolean }).isError).toBe(true);
  const unavailable = await handleMcpRequest({ identity: context.identity }, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  expect((unavailable!.result as { tools: unknown[] }).tools.length).toBeGreaterThan(initial.tools.length);
});
