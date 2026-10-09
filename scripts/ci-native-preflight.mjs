#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Fail before tests can silently skip real tmux or Neovim coverage. */
export function nativePreflight() {
  if (process.version !== "v24.18.0") throw new Error(`Expected Node v24.18.0, got ${process.version}`);
  const requirements = [
    ["pnpm", ["--version"], /^11\.5\.0\s*$/u],
    ["tmux", ["-V"], /^tmux (\d+)\.(\d+)/u],
    ["nvim", ["--version"], /^NVIM v(\d+)\.(\d+)/u],
    ["zsh", ["--version"]],
    ["bash", ["--version"]],
    ["git", ["--version"]],
    ["python3", ["--version"]],
    ["make", ["--version"]],
    ["c++", ["--version"]],
  ];
  for (const [command, args, pattern] of requirements) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`Native CI requires ${command}: ${result.error?.message ?? `exit ${result.status}`}`);
    }
    const output = result.stdout.trim();
    const version = pattern?.exec(output);
    if (pattern && !version) throw new Error(`Unexpected ${command} version: ${output.split("\n")[0]}`);
    if (command === "tmux" && (Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 3))) {
      throw new Error("Native CI requires tmux >=3.3");
    }
    if (command === "nvim" && Number(version[1]) === 0 && Number(version[2]) < 10) {
      throw new Error("Native CI requires Neovim >=0.10");
    }
    console.log(`${command}: ${output.split("\n")[0]}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) nativePreflight();
