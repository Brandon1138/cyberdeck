import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface McpBrokerTransport {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "cyberdeck_threads_list",
    description: "List worker threads visible to this Cyberdeck orchestrator.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cyberdeck_thread_read",
    description: "Read durable events from one worker thread after a transcript cursor.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        afterCursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_worker_start",
    description: "Start an explicitly selected worker inside this orchestrator's scope and budget.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["codex", "claude"] },
        model: { type: "string" },
        cwd: { type: "string" },
        sandbox: { type: "string", enum: ["read-only", "workspace-write"] },
        prompt: { type: "string" },
        name: { type: "string" },
      },
      required: ["provider", "cwd", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_thread_message",
    description: "Queue one complete instruction for a worker. Human control always has priority.",
    inputSchema: {
      type: "object",
      properties: {
        targetSessionId: { type: "string" },
        message: { type: "string" },
        messageId: { type: "string" },
      },
      required: ["targetSessionId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workflow_create",
    description: "Create an explicit bounded workflow. Only a bound orchestrator can do this.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        participantSessionIds: { type: "array", items: { type: "string" } },
        limits: {
          type: "object",
          properties: {
            maxMessages: { type: "integer", minimum: 1, maximum: 1000 },
            maxTurns: { type: "integer", minimum: 1, maximum: 200 },
            maxHops: { type: "integer", minimum: 0, maximum: 50 },
          },
          additionalProperties: false,
        },
      },
      required: ["name", "participantSessionIds"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workflow_status",
    description: "List bounded workflows in which this agent is a participant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cyberdeck_workflow_changes",
    description: "Read workflow mailbox messages after a cursor without waking another agent.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, afterCursor: { type: "integer", minimum: 0 } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workflow_send",
    description: "Send a workflow message. wake defaults to false and must be explicit to prompt the target.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        targetSessionId: { type: "string" },
        text: { type: "string" },
        wake: { type: "boolean", default: false },
        messageId: { type: "string" },
        causationId: { type: "string" },
      },
      required: ["runId", "targetSessionId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_workflow_cancel",
    description: "Cancel a workflow owned by this orchestrator.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false,
    },
  },
] as const;

export async function runMcpServer(
  transport: McpBrokerTransport,
  actorSessionId: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let tail = Promise.resolve();
  for await (const line of lines) {
    if (line.trim() === "") continue;
    tail = tail.then(async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        output.write(`${JSON.stringify(errorResponse(null, -32700, "Parse error"))}\n`);
        return;
      }
      const response = await handleMcpRequest(transport, actorSessionId, request);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    });
  }
  await tail;
}

export async function handleMcpRequest(
  transport: McpBrokerTransport,
  actorSessionId: string,
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | undefined> {
  if (request.id === undefined) return undefined;
  try {
    if (request.method === "initialize") {
      return success(request.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "cyberdeck", version: "0.1.0" },
      });
    }
    if (request.method === "ping") return success(request.id, {});
    if (request.method === "tools/list") return success(request.id, { tools: TOOLS });
    if (request.method === "tools/call") {
      const name = request.params?.name;
      const args = isRecord(request.params?.arguments) ? request.params.arguments : {};
      const result = await callTool(transport, actorSessionId, name, args);
      return success(request.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
      });
    }
    return errorResponse(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    return success(request.id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    });
  }
}

async function callTool(
  transport: McpBrokerTransport,
  actorSessionId: string,
  name: unknown,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "cyberdeck_threads_list") {
    return transport.request("agent.thread.list", { actorSessionId });
  }
  if (name === "cyberdeck_thread_read") {
    return transport.request("agent.thread.read", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_worker_start") {
    return transport.request("agent.worker.start", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_thread_message") {
    return transport.request("agent.thread.enqueue", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workflow_create") {
    return transport.request("agent.workflow.create", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workflow_status") {
    return transport.request("agent.workflow.list", { actorSessionId });
  }
  if (name === "cyberdeck_workflow_changes") {
    return transport.request("agent.workflow.changes", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workflow_send") {
    return transport.request("agent.workflow.send", { actorSessionId, ...args });
  }
  if (name === "cyberdeck_workflow_cancel") {
    return transport.request("agent.workflow.cancel", { actorSessionId, ...args });
  }
  throw new Error(`Unknown Cyberdeck tool ${String(name)}`);
}

function success(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
