import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest, type McpServerContext } from "../../src/mcp/server.js";
import { ATTENTION_TOOL_CAPABILITIES } from "../../src/orchestration/orchestrator-attention-control.js";
import { ACTOR, WORKER, OTHER, attentionHarness, cleanupAttentionHarnesses } from "../support/attention-harness.js";

afterEach(cleanupAttentionHarnesses);

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

  it("carries authorized epoch discovery through the MCP error response without allowing actor spoofing", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request());
    const transport: McpServerContext["transport"] = { request: async (_method, params) =>
      await f.attention.arm(params as ReturnType<typeof f.request>) as never };
    const request = { jsonrpc: "2.0" as const, id: 1, method: "tools/call",
      params: { name: "cyberdeck_attention_arm", arguments: f.request() } };
    const response = await handleMcpRequest({ identity: { actorSessionId: ACTOR }, transport }, request);
    const payload = (response!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(payload)).toMatchObject({ failure: { code: "ATTENTION_ALREADY_ARMED",
      message: expect.stringContaining(`epoch=${armed.epoch} status=armed`) } });
    const denied = await handleMcpRequest({ identity: { actorSessionId: OTHER }, transport }, request);
    const deniedPayload = (denied!.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(deniedPayload)).toMatchObject({ failure: { code: "ACTOR_NOT_AUTHORIZED" } });
    expect(deniedPayload).not.toContain(armed.epoch);
  });
});
