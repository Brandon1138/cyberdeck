import { createServer } from "node:http";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { CyberdeckMcpLaunch } from "../provider.js";
import { ensurePrivateDirectory } from "../../persistence/private-files.js";
import { codexDeveloperInstructions } from "./native-session-identity.js";
import { readCodexDeveloperInstructions } from "./effective-instructions.js";

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
  cwd?: string;
  resolveDeveloperInstructions?: (cwd: string) => Promise<string | undefined>;
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
      forward(client, upstream, (data) => prepareCodexThreadMcp(data, options));
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

/** Pure request transformation, also usable when a host cannot open a fixture socket. */
export function bindCodexThreadMcp(data: RawData, options: CodexRemoteMcpBridgeOptions, inherited?: string): RawData {
  const message = JSON.parse(data.toString()) as { method?: string; params?: Record<string, unknown> };
  if (!THREAD_METHODS.has(message.method ?? "")) return data;
  const params = message.params ?? {};
  const config = params.config as Record<string, unknown> | undefined;
  message.params = {
    ...params,
    // Bind at the same native boundary as MCP: remote TUI config forwarding cannot omit identity.
    developerInstructions: codexDeveloperInstructions(options.sessionId,
      typeof params.developerInstructions === "string" ? params.developerInstructions
        : typeof config?.developer_instructions === "string" ? config.developer_instructions : inherited),
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

export async function prepareCodexThreadMcp(data: RawData, options: CodexRemoteMcpBridgeOptions): Promise<RawData> {
  const message = JSON.parse(data.toString()) as { method?: string; params?: Record<string, unknown> };
  if (!THREAD_METHODS.has(message.method ?? "")) return data;
  const params = message.params ?? {}, config = params.config as Record<string, unknown> | undefined;
  let inherited: string | undefined;
  if (typeof params.developerInstructions !== "string" && typeof config?.developer_instructions !== "string") {
    const cwd = typeof params.cwd === "string" ? params.cwd : options.cwd ?? process.cwd();
    inherited = await (options.resolveDeveloperInstructions ?? ((directory) => readCodexDeveloperInstructions({
      cwd: directory, env: { ...process.env, CODEX_HOME: options.homeDirectory },
    })))(cwd);
  }
  return bindCodexThreadMcp(data, options, inherited);
}

function forward(source: WebSocket, destination: WebSocket, transform?: (data: RawData) => RawData | Promise<RawData>): void {
  let pending = Promise.resolve();
  source.on("message", (data, binary) => {
    source.pause();
    pending = pending.then(async () => {
      const forwarded = binary || !transform ? data : await transform(data);
      await new Promise<void>((resolve, reject) => destination.send(forwarded, { binary }, error => error ? reject(error) : resolve()));
      source.resume();
    }).catch(() => { source.terminate(); destination.terminate(); });
  });
}
