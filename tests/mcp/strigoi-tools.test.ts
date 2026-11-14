import { expect, it, vi } from "vitest";
import { handleMcpRequest } from "../../src/mcp/server.js";
it("exposes only four resident agent tools, never operator configuration or Alfred", async () => {
  const response = await handleMcpRequest({ identity: { actorSessionId: "bound" } }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = (response!.result as { tools: { name: string }[] }).tools;
  expect(tools.filter(t => t.name.includes("strigoi")).map(t => t.name).sort()).toEqual(["cyberdeck_strigoi_acknowledge", "cyberdeck_strigoi_checkpoint", "cyberdeck_strigoi_read", "cyberdeck_strigoi_renew"]);
  expect(tools.some(t => /alfred/.test(t.name))).toBe(false);
});
it("binds the actor after untrusted arguments for every resident tool", async () => {
  const request = vi.fn(async () => ({}));
  for (const name of ["checkpoint", "read", "acknowledge", "renew"]) {
    await handleMcpRequest({ identity: { actorSessionId: "bound" }, transport: { request: request as never } }, { jsonrpc: "2.0", id: name, method: "tools/call", params: { name: `cyberdeck_strigoi_${name}`, arguments: { actorSessionId: "spoof", mutationId: "stable" } } });
    expect(request).toHaveBeenCalledWith(`agent.strigoi.${name}`, { actorSessionId: "bound", mutationId: "stable" });
  }
});
