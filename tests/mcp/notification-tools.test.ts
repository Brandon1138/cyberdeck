import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest, type McpServerContext } from "../../src/mcp/server.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const SOCKET = "/tmp/cyberdeck-test.sock";
const NOTICE = {
  pending: 2,
  byKind: { settled: 2 },
  oldestAgeSeconds: 4,
  dropped: 0,
  drain: "cyberdeck_notifications_read",
  text: "cyberdeck: 2 notifications pending (2 settled; oldest 4s) → cyberdeck_notifications_read",
};

function context(request: (method: string, params: unknown) => Promise<unknown>): McpServerContext {
  return {
    identity: { actorSessionId: ACTOR, brokerSocketPath: SOCKET },
    transport: { request: request as McpServerContext["transport"] extends infer T ? T extends { request: infer R } ? R : never : never },
  };
}

function blocks(response: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const content = (response?.result as { content: Array<{ text: string }> }).content;
  return content.map((entry) => JSON.parse(entry.text) as Record<string, unknown>);
}

async function call(ctx: McpServerContext, name: string, args: Record<string, unknown> = {}) {
  return handleMcpRequest(ctx, { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
}

describe("orchestrator notification feed tools", () => {
  it("advertises both tools with bounded drain and policy schemas", async () => {
    const response = await handleMcpRequest(context(vi.fn()), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (response?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, { maximum?: number; enum?: string[] }> } }> }).tools;
    const read = tools.find(({ name }) => name === "cyberdeck_notifications_read");
    expect(read?.inputSchema.properties.limit?.maximum).toBe(50);
    expect(read?.inputSchema.properties.maxResultChars?.maximum).toBe(4000);
    const configure = tools.find(({ name }) => name === "cyberdeck_notifications_configure");
    expect(configure?.inputSchema.properties.wake?.enum).toEqual(["all", "steering-only", "off"]);
  });

  it("routes the drain and the policy to the broker with the actor attached", async () => {
    const request = vi.fn(async (method: string) => method === "agent.notifications.notice" ? undefined : { ok: true });
    const ctx = context(request);
    await call(ctx, "cyberdeck_notifications_read", { cursor: 3, limit: 10, acknowledgeThrough: 3 });
    await call(ctx, "cyberdeck_notifications_configure", { wake: "off", quietMinutes: 5 });
    expect(request.mock.calls).toEqual([
      ["agent.notifications.read", { actorSessionId: ACTOR, cursor: 3, limit: 10, acknowledgeThrough: 3 }],
      ["agent.notifications.configure", { actorSessionId: ACTOR, policy: { wake: "off", quietMinutes: 5 } }],
    ]);
  });

  it("appends one cyberdeckNotice block to another tool's result when the broker has one", async () => {
    const request = vi.fn(async (method: string) =>
      method === "agent.notifications.notice" ? { notice: NOTICE } : { threads: [] });
    const response = await call(context(request), "cyberdeck_threads_list");
    expect(blocks(response)).toEqual([{ threads: [] }, { cyberdeckNotice: NOTICE }]);
    expect(request).toHaveBeenLastCalledWith("agent.notifications.notice", { actorSessionId: ACTOR });
  });

  it("never decorates the drain, the policy call or diagnosis, and never asks the broker for them", async () => {
    const request = vi.fn(async (method: string) =>
      method === "agent.notifications.notice" ? { notice: NOTICE } : { notifications: [] });
    const ctx = context(request);
    expect(blocks(await call(ctx, "cyberdeck_notifications_read"))).toEqual([{ notifications: [] }]);
    expect(blocks(await call(ctx, "cyberdeck_notifications_configure", {}))).toEqual([{ notifications: [] }]);
    expect(request.mock.calls.map(([method]) => method)).not.toContain("agent.notifications.notice");
  });

  it("leaves the tool result untouched when the notice round trip fails or answers nothing", async () => {
    const failing = vi.fn(async (method: string) => {
      if (method === "agent.notifications.notice") throw new Error("broker went away");
      return { threads: [] };
    });
    expect(blocks(await call(context(failing), "cyberdeck_threads_list"))).toEqual([{ threads: [] }]);
    const empty = vi.fn(async (method: string) =>
      method === "agent.notifications.notice" ? { notice: undefined } : { threads: [] });
    expect(blocks(await call(context(empty), "cyberdeck_threads_list"))).toEqual([{ threads: [] }]);
  });

  it("fabricates no notice when the broker is unreachable", async () => {
    const response = await handleMcpRequest({
      identity: { actorSessionId: ACTOR, brokerSocketPath: SOCKET },
      brokerUnavailable: "down",
    }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "cyberdeck_threads_list", arguments: {} } });
    const content = (response?.result as { content: Array<{ text: string }>; isError?: boolean });
    expect(content.isError).toBe(true);
    expect(content.content).toHaveLength(1);
  });
});
