import { spawn } from "node:child_process";
import { platform, release, arch } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandProbeResult {
  executable: string;
  available: boolean;
  output: string;
}

function locateExecutable(command: string): Promise<string> {
  if (command.includes("/")) {
    return Promise.resolve(command);
  }

  return new Promise((resolvePath) => {
    const child = spawn("/usr/bin/which", [command], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => resolvePath(command));
    child.on("close", (code) => resolvePath(code === 0 ? output.trim() : command));
  });
}

export async function probeCommand(
  command: string,
  args: readonly string[],
): Promise<CommandProbeResult> {
  const executable = await locateExecutable(command);

  return new Promise((resolveResult) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CommandProbeResult) => {
      if (!settled) {
        settled = true;
        resolveResult(result);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish({ executable, available: false, output: "" }));
    child.on("close", (code) => {
      finish({
        executable,
        available: code === 0,
        output: `${stdout}${stderr}`.trim(),
      });
    });
  });
}

const probes = [
  ["node", ["--version"]],
  ["pnpm", ["--version"]],
  ["tmux", ["-V"]],
  ["codex", ["--version"]],
  ["claude", ["--version"]],
  ["agent", ["--version"]],
  ["agy", ["--version"]],
] as const;

async function main(): Promise<void> {
  const results = await Promise.all(
    probes.map(async ([command, args]) => [command, await probeCommand(command, args)] as const),
  );

  process.stdout.write(`${JSON.stringify({
    capturedAt: new Date().toISOString(),
    platform: { platform: platform(), release: release(), arch: arch() },
    results: Object.fromEntries(results),
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
