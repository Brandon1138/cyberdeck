import { resolve } from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: { stdio?: "ignore" | "inherit"; encoding?: "utf8" },
) => { status: number | null; stdout?: string };

export interface CockpitOptions {
  cliPath: string;
  cwd: string;
  orchestratorSessionId: string;
  nodePath?: string;
  spawnSync?: SpawnSyncLike;
  preflight?: CockpitPreflight;
}

/** Options for the presentation-only cockpit helpers that never touch a provider process. */
export interface CockpitPresentationOptions {
  spawnSync?: SpawnSyncLike;
}

export interface CockpitPreflightOptions extends CockpitPresentationOptions {
  insideTmux?: boolean;
}

export interface CockpitPreflight {
  tmuxVersion: string;
  presentationCommand: "attach-session" | "switch-client";
}

export interface CockpitPane {
  paneId: string;
  index: number;
  command: string;
}

/**
 * tmux is presentation only.
 *
 * The cockpit multiplexes *views* of broker-owned state. It never starts, signals, or terminates a
 * provider process. The only terminating verb it may emit is `kill-session`, transactionally and
 * only for a cockpit session created by this invocation when cockpit creation or presentation
 * fails. A session's lifetime belongs to the broker; closing or detaching a pane changes only what
 * the operator is looking at. Stopping actual work is `cyberdeck stop <id>`, which goes through the
 * broker.
 */
export function launchCockpit(options: CockpitOptions): void {
  const spawnSync = options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = resolve(options.cliPath);
  const preflight = options.preflight ?? preflightCockpit({ spawnSync });
  const sessionName = cockpitSessionName(options.cwd);
  const hasSession = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
  let created = false;

  try {
    let needsOrchestratorPane = true;
    if (hasSession.status !== 0) {
      requireSuccess(spawnSync("tmux", [
        "new-session",
        "-d",
        "-s",
        sessionName,
        nodePath,
        cliPath,
        "dashboard",
      ], { stdio: "ignore" }), "create cyberdeck tmux session");
      created = true;
    } else {
      const panes = spawnSync(
        "tmux",
        ["list-panes", "-t", sessionName, "-F", "#{pane_start_command}"],
        { encoding: "utf8" },
      );
      requireSuccess(panes, "inspect cyberdeck tmux panes");
      needsOrchestratorPane = !(panes.stdout ?? "").includes(options.orchestratorSessionId);
    }

    if (needsOrchestratorPane) {
      requireSuccess(
        spawnSync("tmux", [
          "split-window",
          "-h",
          "-t",
          sessionName,
          nodePath,
          cliPath,
          "attach",
          options.orchestratorSessionId,
        ], { stdio: "ignore" }),
        "create orchestrator attachment pane",
      );
    }

    requireSuccess(
      spawnSync("tmux", [preflight.presentationCommand, "-t", sessionName], { stdio: "inherit" }),
      `${preflight.presentationCommand === "switch-client" ? "switch to" : "attach"} cyberdeck tmux session`,
    );
  } catch (error) {
    if (!created) throw error;
    const rollback = spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    if (rollback.status !== 0) {
      throw addCleanupContext(error, "tmux failed to remove the newly created cockpit session");
    }
    throw error;
  }
}

/** Validate native tmux and choose presentation before a provider is created or resumed. */
export function preflightCockpit(options: CockpitPreflightOptions = {}): CockpitPreflight {
  const spawnSync = options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const version = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (version.status !== 0) {
    throw Object.assign(
      new Error("Native tmux is required for `cyberdeck cockpit`; install tmux and retry"),
      { code: "TMUX_NOT_AVAILABLE" },
    );
  }
  const insideTmux = options.insideTmux ?? Boolean(process.env.TMUX);
  return {
    tmuxVersion: (version.stdout ?? "").trim(),
    presentationCommand: insideTmux ? "switch-client" : "attach-session",
  };
}

export function cockpitSessionName(cwd: string): string {
  return `cyberdeck-${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 10)}`;
}

/**
 * Detach every client from the cockpit session without ending it.
 *
 * `detach-client` is the only verb used, so this is observably a presentation change: the tmux
 * session, its panes, and every broker-owned runtime keep running. A missing cockpit session is
 * already the desired end state, so it is not an error.
 */
export function detachCockpit(options: CockpitPresentationOptions = {}): void {
  const spawnSync = options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  spawnSync("tmux", ["detach-client", "-s", "cyberdeck"], { stdio: "ignore" });
}

/**
 * Read-only pane metadata for the cockpit session. Used to verify cockpit layout and cleanup
 * without inferring anything about provider processes: `pane_current_command` is the command tmux
 * sees in the pane, which is not evidence about a broker-owned provider runtime.
 */
export function inspectCockpitPanes(options: CockpitPresentationOptions = {}): CockpitPane[] {
  const spawnSync = options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const result = spawnSync(
    "tmux",
    ["list-panes", "-t", "cyberdeck", "-F", "#{pane_id} #{pane_index} #{pane_current_command}"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return (result.stdout ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const [paneId, index, ...rest] = line.trim().split(" ");
      if (paneId === undefined || index === undefined) return [];
      return [{ paneId, index: Number(index), command: rest.join(" ") }];
    });
}

function requireSuccess(result: { status: number | null }, action: string): void {
  if (result.status !== 0) throw new Error(`tmux failed to ${action}`);
}

function addCleanupContext(primary: unknown, cleanupMessage: string): Error {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const combined = new Error(`${primaryError.message}; cleanup also failed: ${cleanupMessage}`, { cause: primaryError });
  if ("code" in primaryError) Object.assign(combined, { code: primaryError.code });
  return combined;
}
