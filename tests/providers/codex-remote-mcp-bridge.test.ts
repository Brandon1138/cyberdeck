import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCodexRemoteMcpBridge, type CodexRemoteMcpBridge } from "../../src/providers/codex/remote-mcp-bridge.js";

describe("Codex remote MCP bridge", () => {
  let directory: string;
  let homeDirectory: string;
  let server: Server;
  let upstream: WebSocketServer;
  const bridges: CodexRemoteMcpBridge[] = [];
  const clients: WebSocket[] = [];
  const mcp = { nodePath: "/node", cliPath: "/cyberdeck.js" };

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/cd-mcp-test-");
    homeDirectory = join(directory, "home");
    await mkdir(join(homeDirectory, "app-server-control"), { recursive: true });
    server = createServer();
    upstream = new WebSocketServer({ server });
    upstream.on("connection", (socket) => socket.on("message", (data, binary) => {
      // Echo the native request so the test can observe exactly what the daemon received.
      socket.send(data, { binary });
    }));
    server.listen(join(homeDirectory, "app-server-control", "app-server-control.sock"));
    await once(server, "listening");
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
    for (const client of upstream.clients) client.terminate();
    upstream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  async function connect(sessionId = "orc-one") {
    const bridge = await openCodexRemoteMcpBridge({
      sessionId, homeDirectory, mcp, socketRoot: join(directory, "bridge"),
    });
    bridges.push(bridge);
    const client = new WebSocket("ws://localhost", {
      createConnection: () => createConnection(bridge.address.slice("unix://".length)),
    });
    clients.push(client);
    await once(client, "open");
    return { bridge, client };
  }

  async function echo(client: WebSocket, message: unknown) {
    const reply = once(client, "message");
    client.send(JSON.stringify(message));
    const [data] = await reply;
    return JSON.parse(data.toString());
  }

  it.each(["thread/start", "thread/resume", "thread/fork"])(
    "binds the actor's MCP server for %s while preserving native settings and other servers",
    async (method) => {
      const { client } = await connect();
      const result = await echo(client, {
        id: 7, method,
        params: {
          threadId: "native-thread", developerInstructions: "instructions", model: "gpt-6.1-sol",
          config: {
            model_reasoning_effort: "xhigh",
            "mcp_servers.codex_tui": { url: "http://localhost:9000" },
            "mcp_servers.cyberdeck": { command: "wrong", args: ["another-actor"] },
          },
        },
      });
      expect(result).toEqual({
        id: 7, method,
        params: {
          threadId: "native-thread", developerInstructions: "instructions", model: "gpt-6.1-sol",
          config: {
            model_reasoning_effort: "xhigh",
            "mcp_servers.codex_tui": { url: "http://localhost:9000" },
            "mcp_servers.cyberdeck": {
              command: "/node", args: ["/cyberdeck.js", "mcp", "--actor-session", "orc-one"],
            },
          },
        },
      });
    },
  );

  it("keeps two simultaneous orchestrators bound to their own actors without shared config writes", async () => {
    const one = await connect("orc-one");
    const two = await connect("orc-two");
    const [first, second] = await Promise.all([
      echo(one.client, { id: 1, method: "thread/start", params: {} }),
      echo(two.client, { id: 1, method: "thread/start", params: {} }),
    ]);
    expect(first.params.config["mcp_servers.cyberdeck"].args.at(-1)).toBe("orc-one");
    expect(second.params.config["mcp_servers.cyberdeck"].args.at(-1)).toBe("orc-two");
    await expect(stat(join(homeDirectory, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes ordinary requests, server requests, notifications and binary frames unchanged", async () => {
    const { client } = await connect();
    for (const message of [
      { id: 1, method: "initialize", params: { clientInfo: { name: "codex_tui" } } },
      { method: "initialized" },
      { id: 2, result: { approved: true } },
      { method: "turn/completed", params: { threadId: "native", turn: { status: "completed" } } },
    ]) expect(await echo(client, message)).toEqual(message);
    const reply = once(client, "message");
    const frame = Buffer.from([0, 1, 255]);
    client.send(frame);
    const [data, binary] = await reply;
    expect(data).toEqual(frame);
    expect(binary).toBe(true);
  });

  it("removes only its private socket on idempotent cleanup and leaves the daemon available", async () => {
    const { bridge, client } = await connect();
    const closed = once(client, "close");
    await bridge.close();
    await closed;
    await bridge.close();
    await expect(stat(bridge.address.slice("unix://".length))).rejects.toMatchObject({ code: "ENOENT" });
    expect(server.listening).toBe(true);
    const next = await connect("resumed-orc");
    expect((await echo(next.client, { id: 1, method: "thread/start", params: {} }))
      .params.config["mcp_servers.cyberdeck"].args.at(-1)).toBe("resumed-orc");
  });

  it("refuses launch when the daemon socket is unreachable", async () => {
    await expect(openCodexRemoteMcpBridge({
      sessionId: "orc", homeDirectory: join(directory, "missing"), mcp,
      socketRoot: join(directory, "bridge"),
    })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(directory, "bridge"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
