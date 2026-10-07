#!/usr/bin/env node
// Minimal stdio MCP server: newline-delimited JSON-RPC 2.0, one tool `echo` {text}.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return; // notifications (notifications/initialized etc.)
  switch (method) {
    case "initialize":
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "0.0.1" },
      } });
    case "ping":
      return send({ jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return send({ jsonrpc: "2.0", id, result: { tools: [{
        name: "echo",
        description: "Echo the given text back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }] } });
    case "tools/call": {
      const text = params?.arguments?.text;
      if (text === "fail") {
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "echo failed on purpose" }], isError: true } });
      }
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(text ?? "") }] } });
    }
    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
