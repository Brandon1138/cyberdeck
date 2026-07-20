import { resolve } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: { stdio?: "ignore" | "inherit" },
) => { status: number | null };

export interface CockpitOptions {
  cliPath: string;
  nodePath?: string;
  spawnSync?: SpawnSyncLike;
}

export function launchCockpit(options: CockpitOptions): void {
  const spawnSync = options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = resolve(options.cliPath);
  const hasSession = spawnSync("tmux", ["has-session", "-t", "cyberdeck"], { stdio: "ignore" });

  if (hasSession.status !== 0) {
    requireSuccess(spawnSync("tmux", [
      "new-session",
      "-d",
      "-s",
      "cyberdeck",
      nodePath,
      cliPath,
      "dashboard",
    ], { stdio: "ignore" }), "create cyberdeck tmux session");
    requireSuccess(
      spawnSync("tmux", ["split-window", "-h", "-t", "cyberdeck"], { stdio: "ignore" }),
      "create cockpit shell pane",
    );
  }

  requireSuccess(
    spawnSync("tmux", ["attach-session", "-t", "cyberdeck"], { stdio: "inherit" }),
    "attach cyberdeck tmux session",
  );
}

function requireSuccess(result: { status: number | null }, action: string): void {
  if (result.status !== 0) throw new Error(`tmux failed to ${action}`);
}
