import { describe, expect, it, vi } from "vitest";
import {
  handleMcpRequest,
  type McpBrokerTransport,
  type McpServerContext,
} from "../../src/mcp/server.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const SOCKET = "/tmp/cyberdeck-test.sock";

function context(transport: McpBrokerTransport): McpServerContext {
  return { identity: { actorSessionId: ACTOR, brokerSocketPath: SOCKET }, transport };
}

async function call(
  transport: McpBrokerTransport,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await handleMcpRequest(context(transport), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const content = (response?.result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

async function tools(): Promise<Array<{
  name: string;
  description: string;
  inputSchema: {
    properties?: Record<string, {
      enum?: string[];
      maximum?: number;
      maxItems?: number;
      default?: unknown;
      items?: { enum?: string[] };
    }>;
    required?: string[];
    additionalProperties?: boolean;
  };
}>> {
  const response = await handleMcpRequest(context({ request: vi.fn() }), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  return (response?.result as { tools: never[] }).tools;
}

describe("orchestrator control-plane tools", () => {
  it("advertises the three control-plane tools with their action and scope vocabularies", async () => {
    const listed = await tools();
    const lease = listed.find(({ name }) => name === "cyberdeck_lease");
    const control = listed.find(({ name }) => name === "cyberdeck_worker_ctl");
    const events = listed.find(({ name }) => name === "cyberdeck_worker_events");

    expect(lease?.inputSchema.properties?.action?.enum)
      .toEqual(["acquire", "renew", "release", "transfer", "adopt"]);
    expect(lease?.inputSchema.properties?.scope?.enum).toEqual(["worker", "wave", "all-eligible"]);
    expect(lease?.inputSchema.required).toEqual(["action", "scope", "reason"]);
    expect(control?.inputSchema.properties?.action?.enum)
      .toEqual(["stop", "redirect", "request_checkpoint"]);
    expect(control?.inputSchema.properties?.mode?.enum).toEqual(["graceful", "force"]);
    expect(events?.inputSchema.properties?.view?.enum)
      .toEqual(["active", "unresolved", "resolved", "all"]);
    expect(events?.inputSchema.properties?.kinds).toMatchObject({
      items: { enum: ["EXCEPTION", "PROGRESS", "CHECKPOINT", "RISK", "DECISION_REQUEST"] },
    });
    // The page cap lives in the schema so an Orc cannot request a transcript-sized read.
    expect(events?.inputSchema.properties?.limit?.maximum).toBe(50);
    expect(events?.inputSchema.properties?.acknowledgeHandoffIds?.maxItems).toBe(1);
    for (const tool of [lease, control, events]) {
      expect(tool?.inputSchema.additionalProperties).toBe(false);
      expect(tool?.description.length).toBeLessThan(720);
    }
  });

  it("routes each tool to its broker method with the actor session attached", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const transport: McpBrokerTransport = { request: request as never };

    await call(transport, "cyberdeck_lease", {
      action: "adopt", scope: "all-eligible", reason: "recovery", preview: true,
    });
    await call(transport, "cyberdeck_worker_ctl", {
      action: "stop", workerId: WORKER, reason: "scope changed",
    });
    await call(transport, "cyberdeck_worker_events", {
      cursor: 12,
      view: "unresolved",
      acknowledgeHandoffIds: [WORKER],
    });

    expect(request.mock.calls).toEqual([
      ["agent.lease.control", {
        actorSessionId: ACTOR, action: "adopt", scope: "all-eligible", reason: "recovery", preview: true,
      }],
      ["agent.worker.control", {
        actorSessionId: ACTOR, action: "stop", workerId: WORKER, reason: "scope changed",
      }],
      ["agent.worker.events", {
        actorSessionId: ACTOR,
        cursor: 12,
        view: "unresolved",
        acknowledgeHandoffIds: [WORKER],
      }],
    ]);
  });

  it("passes substrate outcome codes through verbatim", async () => {
    const transport: McpBrokerTransport = {
      request: vi.fn(async () => ({
        action: "acquire",
        scope: "worker",
        results: [{
          workerId: WORKER,
          code: "LEASE_CONFLICT",
          currentController: "orchestrator:workspace:/other",
          leaseExpiresAt: "2026-07-27T10:00:30.000Z",
        }],
        summary: { LEASE_CONFLICT: 1 },
      })) as never,
    };

    const result = await call(transport, "cyberdeck_lease", {
      action: "acquire", scope: "worker", workerId: WORKER, reason: "takeover",
    });
    expect((result.results as Array<Record<string, unknown>>)[0]).toEqual({
      workerId: WORKER,
      code: "LEASE_CONFLICT",
      currentController: "orchestrator:workspace:/other",
      leaseExpiresAt: "2026-07-27T10:00:30.000Z",
    });
  });

  it("explains an unbound transfer target with an actionable remedy", async () => {
    const transport: McpBrokerTransport = {
      request: vi.fn(async () => {
        throw Object.assign(new Error("transfer target holds no binding"), {
          code: "TRANSFER_TARGET_UNBOUND",
        });
      }) as never,
    };

    const result = await call(transport, "cyberdeck_lease", {
      action: "transfer", scope: "worker", workerId: WORKER, reason: "hand off",
      toSessionId: "44444444-4444-4444-8444-444444444444",
    });
    expect(result.error).toMatchObject({
      code: "TRANSFER_TARGET_UNBOUND",
      actorSessionId: ACTOR,
    });
    expect((result.error as { remedy: string }).remedy).toContain("no stable orchestrator binding");
  });
});
