import { createServer } from "node:http";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { CyberdeckMcpLaunch } from "../provider.js";
import { ensurePrivateDirectory } from "../../persistence/private-files.js";

export interface CodexRemoteMcpBridge {
  readonly address: string;
  close(): Promise<void>;
}

export interface CodexRemoteMcpBridgeOptions {
  sessionId: string;
  homeDirectory: string;
  mcp: CyberdeckMcpLaunch;
  /** Short private root: macOS Unix socket paths cannot use the longer system TMPDIR. */
  socketRoot?: string;
}

export type CodexRemoteMcpBridgeFactory = (
  options: CodexRemoteMcpBridgeOptions,
) => Promise<CodexRemoteMcpBridge>;

const THREAD_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

/**
 * The remote TUI forwards only selected -c settings and drops mcp_servers. Bind the server at the
 * native thread boundary instead, without writing a shared daemon config or changing RC ownership.
 */
export const openCodexRemoteMcpBridge: CodexRemoteMcpBridgeFactory = async (options) => {
  const upstreamPath = join(options.homeDirectory, "app-server-control", "app-server-control.sock");
  const connect = () => new WebSocket("ws://localhost", {
    createConnection: () => createConnection(upstreamPath),
    handshakeTimeout: 5_000,
    maxPayload: 0,
  });
  // Fail before spawning the TUI when the configured daemon socket cannot accept its transport.
  const probe = connect();
  try { await once(probe, "open"); } finally { probe.terminate(); }

  const root = options.socketRoot ?? join("/tmp", `cyberdeck-codex-${process.getuid?.() ?? "user"}`);
  await ensurePrivateDirectory(root);
  const directory = await mkdtemp(join(root, "orc-"));
  const socketPath = join(directory, "remote.sock");
  const server = createServer();
  const clients = new WebSocketServer({ server, maxPayload: 0 });
  const connections = new Set<WebSocket>();
  let closing: Promise<void> | undefined;

  clients.on("connection", (client) => {
    const upstream = connect();
    connections.add(client);
    connections.add(upstream);
    const terminate = () => { client.terminate(); upstream.terminate(); };
    client.on("error", terminate);
    upstream.on("error", terminate);
    client.on("close", () => { connections.delete(client); upstream.terminate(); });
    upstream.on("close", () => { connections.delete(upstream); client.terminate(); });
    client.pause();
    upstream.once("open", () => {
      forward(client, upstream, (data) => bindMcp(data, options));
      forward(upstream, client);
      client.resume();
    });
  });

  const close = (): Promise<void> => closing ??= (async () => {
    for (const connection of connections) connection.terminate();
    clients.close();
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(directory, { recursive: true, force: true });
  })();

  try {
    server.listen(socketPath);
    await once(server, "listening");
    return { address: `unix://${socketPath}`, close };
  } catch (error) {
    await close();
    throw error;
  }
};

function bindMcp(data: RawData, options: CodexRemoteMcpBridgeOptions): RawData {
  const message = JSON.parse(data.toString()) as { method?: string; params?: Record<string, unknown> };
  if (!THREAD_METHODS.has(message.method ?? "")) return data;
  const params = message.params ?? {};
  message.params = {
    ...params,
    config: {
      ...params.config as object,
      "mcp_servers.cyberdeck": {
        command: options.mcp.nodePath,
        args: [options.mcp.cliPath, "mcp", "--actor-session", options.sessionId],
      },
    },
  };
  return Buffer.from(JSON.stringify(message));
}

function forward(source: WebSocket, destination: WebSocket, transform?: (data: RawData) => RawData): void {
  source.on("message", (data, binary) => {
    try {
      source.pause();
      destination.send(binary || !transform ? data : transform(data), { binary }, (error) => {
        if (error) { source.terminate(); destination.terminate(); }
        else source.resume();
      });
    } catch {
      source.terminate();
      destination.terminate();
    }
  });
}
