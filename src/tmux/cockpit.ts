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
  returnMode?: "detach" | "switch";
}

export interface CockpitPreflightOptions extends CockpitPresentationOptions {
  insideTmux?: boolean;
  /** The pane Fleet occupies, when the caller already knows it. */
  hostPaneId?: string;
}

export interface CockpitPreflight {
  tmuxVersion: string;
  presentationCommand: "attach-session" | "switch-client";
  /**
   * The pane the Fleet process itself occupies, when Fleet runs inside tmux and tmux can still
   * name that pane. Its presence is what makes presentation happen in place — in the window the
   * operator is already looking at — rather than in a cockpit session named after a cwd.
   */
  hostPaneId?: string;
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
 *
 * When Fleet is already inside tmux the operator is looking at exactly one window, and that window
 * is where the orchestrator has to appear. Presentation then targets Fleet's own pane instead of a
 * session named after a cwd: hashing a cwd that Fleet no longer sits in named a *different*
 * session, and switching the client to it hid the window the operator was working in.
 */
export function launchCockpit(options: CockpitOptions): void {
  const spawnSync = options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  const nodePath = options.nodePath ?? process.execPath;
  const cliPath = resolve(options.cliPath);
  const preflight = options.preflight ?? preflightCockpit({ spawnSync });
  if (preflight.hostPaneId !== undefined) {
    presentInHostWindow({
      spawnSync,
      nodePath,
      cliPath,
      hostPaneId: preflight.hostPaneId,
      orchestratorSessionId: options.orchestratorSessionId,
    });
    return;
  }
  const sessionName = cockpitSessionName(options.cwd);
  const hasSession = spawnSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
  let created = false;

  try {
    let needsOrchestratorPane = true;
    let existingOrchestratorPane: string | undefined;
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
      // tmux holds a bare Esc for `escape-time` before passing it to the pane, and its 500ms default
      // is felt as a swallowed Esc by every agent TUI in the cockpit. It also decides whether an
      // Option chord arrives as one Meta chord or as Esc followed by a separate key, which is what
      // made Option+Enter submit sometimes and not others. 10ms still reunites a split sequence.
      // This is a server option, so it is best-effort and never fails a cockpit launch.
      spawnSync("tmux", ["set-option", "-s", "escape-time", "10"], { stdio: "ignore" });
    } else {
      const panes = spawnSync(
        "tmux",
        ["list-panes", "-t", sessionName, "-F", "#{pane_id}\t#{pane_start_command}"],
        { encoding: "utf8" },
      );
      requireSuccess(panes, "inspect cyberdeck tmux panes");
      existingOrchestratorPane = findOrchestratorPane(
        panes.stdout ?? "",
        options.orchestratorSessionId,
      );
      needsOrchestratorPane = existingOrchestratorPane === undefined;
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
          "--cockpit-return",
          preflight.presentationCommand === "switch-client" ? "switch" : "detach",
        ], { stdio: "ignore" }),
        "create orchestrator attachment pane",
      );
    } else {
      requireSuccess(
        spawnSync("tmux", ["select-pane", "-t", existingOrchestratorPane!], { stdio: "ignore" }),
        "focus orchestrator attachment pane",
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

/**
 * Add or focus an orchestrator pane in the window Fleet is already in.
 *
 * The anchor is Fleet's own pane, not the window's active pane and not a hash of any cwd. The
 * workload cwd belongs to the orchestrator the broker owns; it never decides where the view lands.
 * Nothing here creates a session or a window, and no terminating verb is emitted at all: a live
 * pane already carrying this orchestrator is focused, and otherwise Fleet's pane is split beside
 * it, which leaves every operator pane in the window exactly where it was.
 */
function presentInHostWindow(options: {
  spawnSync: SpawnSyncLike;
  nodePath: string;
  cliPath: string;
  hostPaneId: string;
  orchestratorSessionId: string;
}): void {
  const windowId = hostWindowId(options.spawnSync, options.hostPaneId);
  const panes = options.spawnSync(
    "tmux",
    ["list-panes", "-t", windowId, "-F", "#{pane_id}\t#{pane_dead}\t#{pane_start_command}"],
    { encoding: "utf8" },
  );
  requireSuccess(panes, "inspect the tmux window Fleet is running in");
  const existingPane = findLiveOrchestratorPane(
    panes.stdout ?? "",
    options.orchestratorSessionId,
  );
  if (existingPane !== undefined) {
    requireSuccess(
      options.spawnSync("tmux", ["select-pane", "-t", existingPane], { stdio: "ignore" }),
      "focus orchestrator attachment pane",
    );
    return;
  }
  // No `--cockpit-return`: this client is the operator's own, so detaching or switching it on an
  // explicit detach would take the whole window away. Leaving the attachment closes only the pane
  // it owns, and the operator is left looking at the window they started in.
  requireSuccess(
    options.spawnSync("tmux", [
      "split-window",
      "-h",
      "-t",
      options.hostPaneId,
      options.nodePath,
      options.cliPath,
      "attach",
      options.orchestratorSessionId,
    ], { stdio: "ignore" }),
    "create orchestrator attachment pane",
  );
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
  const hostPaneId = insideTmux
    ? options.hostPaneId ?? discoverHostPane(spawnSync, options.insideTmux === undefined)
    : undefined;
  return {
    tmuxVersion: (version.stdout ?? "").trim(),
    // Kept for the managed cockpit session, which is still how a client outside tmux — and a
    // client whose own pane tmux cannot name — reaches an orchestrator.
    presentationCommand: insideTmux ? "switch-client" : "attach-session",
    ...(hostPaneId === undefined ? {} : { hostPaneId }),
  };
}

/**
 * Name the pane this process occupies.
 *
 * `TMUX_PANE` is the only answer that is about *us*: asking tmux for the current pane answers
 * about whichever pane happens to be active, which is the ambiguity this path exists to remove.
 * The query is the fallback for a pane that inherited a scrubbed environment. A caller that states
 * `insideTmux` itself is describing the whole environment, so the ambient one is left alone and
 * preflight stays hermetic under test.
 */
function discoverHostPane(
  spawnSync: SpawnSyncLike,
  consultEnvironment: boolean,
): string | undefined {
  const fromEnvironment = consultEnvironment ? process.env.TMUX_PANE : undefined;
  if (isPaneId(fromEnvironment)) return fromEnvironment.trim();
  const queried = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], { encoding: "utf8" });
  if (queried.status !== 0) return undefined;
  const paneId = (queried.stdout ?? "").trim();
  return isPaneId(paneId) ? paneId : undefined;
}

function isPaneId(value: string | undefined): value is string {
  return value !== undefined && /^%\d+$/.test(value.trim());
}

export function hostWindowId(spawnSync: SpawnSyncLike, hostPaneId: string): string {
  const result = spawnSync(
    "tmux",
    ["display-message", "-p", "-t", hostPaneId, "#{window_id}"],
    { encoding: "utf8" },
  );
  const windowId = (result.stdout ?? "").trim();
  if (result.status !== 0 || windowId === "") {
    throw new Error("tmux failed to locate the window Fleet is running in");
  }
  return windowId;
}

/**
 * The pane in this window already showing this orchestrator, if there is a live one.
 *
 * A pane tmux is holding open after its process exited still advertises the start command that
 * named the orchestrator, so a dead pane is rejected rather than focused. Only the window Fleet
 * is in was listed, so a pane matching in some other window is out of scope by construction.
 */
function findLiveOrchestratorPane(output: string, sessionId: string): string | undefined {
  for (const line of output.split("\n")) {
    const [paneId, dead, ...rest] = line.split("\t");
    if (paneId === undefined || dead === undefined) continue;
    if (dead.trim() !== "0") continue;
    if (rest.join("\t").includes(sessionId)) return paneId;
  }
  return undefined;
}

export function cockpitSessionName(cwd: string): string {
  return `cyberdeck-${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 10)}`;
}

/**
 * Leave the cockpit without ending it.
 *
 * A client switched into the cockpit returns to its previous tmux session. A client attached from
 * outside tmux detaches and returns to the Fleet process whose `attach-session` call is waiting.
 * Both verbs change presentation only; neither touches a broker-owned provider runtime.
 */
export function detachCockpit(options: CockpitPresentationOptions = {}): void {
  const spawnSync = options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike);
  if (options.returnMode === "detach") {
    spawnSync("tmux", ["detach-client"], { stdio: "ignore" });
    return;
  }
  const switched = spawnSync("tmux", ["switch-client", "-l"], { stdio: "ignore" });
  if (switched.status === 0) return;
  spawnSync("tmux", ["detach-client"], { stdio: "ignore" });
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

function findOrchestratorPane(output: string, sessionId: string): string | undefined {
  for (const line of output.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const paneId = line.slice(0, separator);
    const command = line.slice(separator + 1);
    if (command.includes(sessionId)) return paneId;
  }
  return undefined;
}

function addCleanupContext(primary: unknown, cleanupMessage: string): Error {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const combined = new Error(`${primaryError.message}; cleanup also failed: ${cleanupMessage}`, { cause: primaryError });
  if ("code" in primaryError) Object.assign(combined, { code: primaryError.code });
  return combined;
}
