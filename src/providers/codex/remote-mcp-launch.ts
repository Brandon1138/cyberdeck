import { spawn } from "node:child_process";
import { once } from "node:events";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openCodexRemoteMcpBridge, type CodexRemoteMcpBridgeOptions } from "./remote-mcp-bridge.js";

/** This process belongs to the durable PTY, not the broker that happened to launch it. */
export async function runCodexRemoteMcpLaunch(
  options: CodexRemoteMcpBridgeOptions,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const nativeArgs = [...args];
  const remoteIndex = nativeArgs.indexOf("--remote");
  if (remoteIndex < 0 || nativeArgs[remoteIndex + 1] !== "unix://") {
    throw new Error("Codex orchestrator MCP requires its dedicated local app-server");
  }
  const bridge = await openCodexRemoteMcpBridge(options);
  nativeArgs[remoteIndex + 1] = bridge.address;
  const native = spawn("codex", nativeArgs, { env: environment, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listeners = signals.map((signal) => {
    const listener = () => native.kill(signal);
    process.on(signal, listener);
    return { signal, listener };
  });
  try {
    const [code, signal] = await once(native, "exit") as [number | null, NodeJS.Signals | null];
    return code ?? (signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
  } finally {
    for (const { signal, listener } of listeners) process.off(signal, listener);
    native.kill();
    await bridge.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "--actor-session" || args[2] !== "--mcp-node" || args[4] !== "--mcp-cli"
    || args[6] !== "--" || !args[1] || !args[3] || !args[5]) {
    throw new Error("Invalid Codex orchestrator MCP launcher arguments");
  }
  process.exitCode = await runCodexRemoteMcpLaunch({
    sessionId: args[1], mcp: { nodePath: args[3], cliPath: args[5] },
    homeDirectory: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  }, args.slice(7));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`Codex orchestrator MCP: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
