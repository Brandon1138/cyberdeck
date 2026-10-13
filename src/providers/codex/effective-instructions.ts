import { spawn } from "node:child_process";

export type CodexDeveloperInstructionsReader = (options: {
  cwd: string; env: NodeJS.ProcessEnv;
}) => Promise<string | undefined>;

/** Ask the native config loader so project, profile and system precedence stay native. No turn is started. */
export function readCodexDeveloperInstructions(
  options: { cwd: string; env: NodeJS.ProcessEnv },
  command: { executable?: string; args?: readonly string[]; timeoutMs?: number } = {},
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable ?? "codex", [...command.args ?? ["app-server"]], {
      ...options, stdio: ["pipe", "pipe", "ignore"],
    });
    const closed = new Promise<void>(done => child.once("close", () => done()));
    let settled = false, initialized = false, pending = "", bytes = 0;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // Reap only this owned reader, including a native shutdown that ignores SIGTERM.
      const forcedStop = setTimeout(() => {
        child.kill("SIGKILL"); child.stdin.destroy(); child.stdout.destroy();
      }, 250);
      child.stdin.end();
      child.kill();
      void closed.then(() => {
        clearTimeout(forcedStop);
        if (error) reject(error); else resolve(value);
      });
    };
    const failure = () => finish(Object.assign(new Error("Could not read effective Codex developer instructions"), {
      code: "CODEX_CONFIG_UNAVAILABLE",
    }));
    const timeout = setTimeout(failure, command.timeoutMs ?? 10_000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", failure);
    child.on("exit", () => { if (!settled) failure(); });
    child.stdin.on("error", failure);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { failure(); return; }
      pending += chunk;
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) >= 0 && !settled) {
        const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as { id?: unknown; error?: unknown; result?: {
            config?: { developer_instructions?: unknown };
          } };
          if (frame.id === 1 && !initialized) {
            if (frame.error !== undefined || frame.result === undefined) { failure(); return; }
            initialized = true;
            send({ method: "initialized" });
            send({ id: 2, method: "config/read", params: { cwd: options.cwd, includeLayers: false } });
          } else if (frame.id === 2) {
            const config = frame.result?.config;
            if (frame.error !== undefined || !config) { failure(); return; }
            const value = config.developer_instructions;
            if (value !== undefined && value !== null && typeof value !== "string") { failure(); return; }
            finish(undefined, typeof value === "string" ? value : undefined);
          }
        } catch { failure(); }
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "cyberdeck_config_reader", version: "1" },
    } });
  });
}
