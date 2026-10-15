import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest, type McpServerContext } from "../../src/mcp/server.js";
import { ATTENTION_TOOL_CAPABILITIES } from "../../src/orchestration/orchestrator-attention-control.js";
import { ACTOR, WORKER } from "../support/attention-harness.js";

describe("attention MCP surface", () => {
  it("exposes bounded explicit arm/cancel tools with the existing capability mapping", async () => {
    const response = await handleMcpRequest({ identity: { actorSessionId: ACTOR } }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: { required: string[]; properties: Record<string, { maxItems?: number }> } }> }).tools;
    expect(tools.find((tool) => tool.name === "cyberdeck_attention_arm")!.inputSchema.properties.targets!.maxItems).toBe(32);
    expect(tools.find((tool) => tool.name === "cyberdeck_attention_cancel")!.inputSchema.required).toEqual(["epoch"]);
    expect(ATTENTION_TOOL_CAPABILITIES).toEqual({ cyberdeck_attention_arm: "thread.enqueue", cyberdeck_attention_cancel: "thread.enqueue", cyberdeck_notifications_read: "thread.read" });
  });

  it("routes arm/cancel and receipt fields while binding the actor after untrusted arguments", async () => {
    const request = vi.fn<McpServerContext["transport"] extends infer T ? T extends { request: infer R } ? R : never : never>(
      async () => ({ ok: true }) as never);
    const context: McpServerContext = { identity: { actorSessionId: ACTOR }, transport: { request: request as never } };
    for (const [name, args] of [
      ["cyberdeck_attention_arm", { actorSessionId: WORKER, objective: "Wait" }],
      ["cyberdeck_attention_cancel", { actorSessionId: WORKER, epoch: WORKER }],
      ["cyberdeck_notifications_read", { actorSessionId: WORKER, attentionEpoch: WORKER, attentionReceiptId: ACTOR }],
    ] as const) {
      await handleMcpRequest(context, { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
    }
    const calls = request.mock.calls.filter(([method]) => method !== "agent.notifications.notice");
    expect(calls).toEqual([
      ["agent.attention.arm", { actorSessionId: ACTOR, objective: "Wait" }],
      ["agent.attention.cancel", { actorSessionId: ACTOR, epoch: WORKER }],
      ["agent.notifications.read", { actorSessionId: ACTOR, attentionEpoch: WORKER, attentionReceiptId: ACTOR }],
    ]);
  });
});
