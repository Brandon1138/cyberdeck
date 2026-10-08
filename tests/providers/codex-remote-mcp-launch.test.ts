import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const launcher = fileURLToPath(new URL("../../src/providers/codex/remote-mcp-launch.ts", import.meta.url));

describe("Codex terminal-owned MCP launcher", () => {
  let directory: string;
  let home: string;
  let server: Server;
  let upstream: WebSocketServer;

  beforeEach(async () => {
    directory = await mkdtemp("/tmp/cd-launch-test-");
    home = join(directory, "home");
    await mkdir(join(home, "app-server-control"), { recursive: true });
    server = createServer();
    upstream = new WebSocketServer({ server });
    upstream.on("connection", (client) => client.on("message", (data) => client.send(data)));
    server.listen(join(home, "app-server-control", "app-server-control.sock"));
    await once(server, "listening");
    await writeFile(join(directory, "codex"), `#!${process.execPath}
const { createConnection } = require('node:net');
const { writeFileSync } = require('node:fs');
const WebSocket = require(${JSON.stringify(require.resolve("ws"))});
const args = process.argv.slice(2);
const address = args[args.indexOf('--remote') + 1];
const socket = new WebSocket('ws://localhost', { createConnection: () => createConnection(address.slice(7)) });
socket.on('open', () => socket.send(JSON.stringify({id: 1, method: 'thread/start', params: {config: {model_reasoning_effort: 'xhigh'}}})));
socket.on('message', data => {
  writeFileSync(process.env.CD_LAUNCH_PROOF, JSON.stringify({request: JSON.parse(data.toString()), args, address}));
  process.stdout.write('READY\\n');
  if (!args.includes('--stay')) process.exit(7);
});
process.on('SIGTERM', () => process.exit(12));
`, { mode: 0o700 });
  });

  afterEach(async () => {
    for (const client of upstream.clients) client.terminate();
    upstream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  function start(args: string[] = []) {
    return spawn(process.execPath, ["--import", require.resolve("tsx"), launcher,
      "--actor-session", "orc-terminal", "--mcp-node", "/node", "--mcp-cli", "/cyberdeck.js", "--",
      "--remote", "unix://", ...args,
    ], { env: { ...process.env, CODEX_HOME: home, PATH: `${directory}:${process.env.PATH}`,
      CD_LAUNCH_PROOF: join(directory, "proof.json") }, stdio: ["ignore", "pipe", "pipe"] });
  }

  it("keeps the native arguments and exit status, then cleans the private bridge", async () => {
    const child = start(["--no-alt-screen", "--", "Preserve --remote in this prompt"]);
    const [code] = await once(child, "exit");
    expect(code).toBe(7);
    const { request, args, address } = JSON.parse(await readFile(join(directory, "proof.json"), "utf8"));
    expect(request.params.config).toEqual({ model_reasoning_effort: "xhigh",
      "mcp_servers.cyberdeck": { command: "/node", args: ["/cyberdeck.js", "mcp", "--actor-session", "orc-terminal"] } });
    expect(args.slice(2)).toEqual(["--no-alt-screen", "--", "Preserve --remote in this prompt"]);
    await expect(stat(address.slice("unix://".length))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("forwards a stop signal to the native process and exits with its result", async () => {
    const child = start(["--stay"]);
    try {
      await once(child.stdout, "data");
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const [code] = await exited;
      expect(code).toBe(12);
      const { request, address } = JSON.parse(await readFile(join(directory, "proof.json"), "utf8"));
      expect(request.params.config["mcp_servers.cyberdeck"].args.at(-1)).toBe("orc-terminal");
      await expect(stat(address.slice("unix://".length))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      child.kill();
    }
  });

  it("fails visibly before native startup when the dedicated daemon is unreachable", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const child = start();
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data; });
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(stderr).toContain("Codex orchestrator MCP:");
    await expect(readFile(join(directory, "proof.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
