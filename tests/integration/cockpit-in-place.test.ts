import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cockpitSessionName,
  launchCockpit,
  type SpawnSyncLike,
} from "../../src/tmux/cockpit.js";

const ORCHESTRATOR_SESSION_ID = "11111111-1111-4111-8111-111111111111";
/** A cwd Fleet is not sitting in, which is exactly what used to name a second cockpit session. */
const ELSEWHERE = "/repo/hashes-elsewhere";

/**
 * Real tmux, on a server of this test run's own. The live server the operator is sitting in is
 * never reachable from here: `-S` points at a socket inside the run's temp directory, and the
 * ambient `TMUX` variables are stripped so nothing can fall back to the default socket.
 */
let socket: string;

function tmux(args: string[]): { status: number | null; stdout: string } {
  const environment = { ...process.env };
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  const result = spawnSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    env: environment,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

const privateSocket: SpawnSyncLike = (command, args) => {
  if (command !== "tmux") throw new Error(`cockpit presentation ran ${command}, not tmux`);
  return tmux(args);
};

function lines(args: string[]): string[] {
  return tmux(args).stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

describe.skipIf(!hasTmux)("cockpit presentation in the window Fleet occupies", () => {
  let directory: string;
  let fakeCli: string;
  let hostPane: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "cyberdeck-cockpit-"));
    socket = join(directory, "tmux.sock");
    fakeCli = join(directory, "fake-cli.mjs");
    // Stands in for `cyberdeck attach <id>`: the pane only has to stay alive and carry the
    // orchestrator id in its start command, which is what pane reuse reads.
    writeFileSync(fakeCli, "setInterval(() => {}, 1000);\n");
    // `hostA` is the operator's own session, with one pane of their own work in it.
    expect(tmux(["new-session", "-d", "-s", "hostA", "-n", "work", "cat"]).status).toBe(0);
    hostPane = lines(["list-panes", "-t", "hostA:work", "-F", "#{pane_id}"])[0]!;
    expect(hostPane).toMatch(/^%\d+$/);
  });

  afterAll(() => {
    tmux(["kill-server"]);
    rmSync(directory, { recursive: true, force: true });
  });

  function present(): void {
    launchCockpit({
      cliPath: fakeCli,
      nodePath: process.execPath,
      cwd: ELSEWHERE,
      orchestratorSessionId: ORCHESTRATOR_SESSION_ID,
      spawnSync: privateSocket,
      preflight: {
        tmuxVersion: "tmux",
        presentationCommand: "switch-client",
        hostPaneId: hostPane,
      },
    });
  }

  it("adds the orchestrator beside Fleet and never opens a session named after a cwd", () => {
    present();

    const panes = lines(["list-panes", "-t", "hostA:work", "-F", "#{pane_id}"]);
    expect(panes).toHaveLength(2);
    expect(panes).toContain(hostPane);
    expect(lines(["list-windows", "-t", "hostA", "-F", "#{window_id}"])).toHaveLength(1);
    expect(lines(["list-sessions", "-F", "#{session_name}"])).toEqual(["hostA"]);
    expect(lines(["list-sessions", "-F", "#{session_name}"]))
      .not.toContain(cockpitSessionName(ELSEWHERE));
  });

  it("reuses the live pane on a second open rather than stacking another one", () => {
    const before = lines(["list-panes", "-t", "hostA:work", "-F", "#{pane_id}"]);

    present();

    expect(lines(["list-panes", "-t", "hostA:work", "-F", "#{pane_id}"])).toEqual(before);
    expect(lines(["list-sessions", "-F", "#{session_name}"])).toEqual(["hostA"]);
  });
});
