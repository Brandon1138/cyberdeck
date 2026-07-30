import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { decodeNvimPayload } from "../../src/nvim/quickfix.js";
import {
  isWorkerLive,
  openWorktreeInNvim,
  selectSession,
  worktreeSubject,
} from "../../src/nvim/open-worktree.js";
import type { WorktreeBaseline } from "../../src/nvim/worktree-changes.js";
import type { SpawnSyncLike } from "../../src/tmux/cockpit.js";

const FORK_POINT: WorktreeBaseline = { kind: "fork-point", label: "since origin/main" };

const NOW = "2026-07-22T10:00:00.000Z";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    cwd: "/work/tree",
    detached: true,
    sandbox: "read-only",
    name: "worker-one",
    model: "provider-native-model",
    role: "worker",
    createdAt: NOW,
    updatedAt: NOW,
    executionState: "active",
    attachmentState: "detached",
    pid: 4321,
    exitCode: null,
    childIds: [],
    ...overrides,
  } as SessionRecord;
}

describe("isWorkerLive", () => {
  it("counts starting as live, because that is the window a co-edit is lost in", () => {
    expect(isWorkerLive({ executionState: "starting" })).toBe(true);
    expect(isWorkerLive({ executionState: "active" })).toBe(true);
    expect(isWorkerLive({ executionState: "exited" })).toBe(false);
    expect(isWorkerLive({ executionState: "failed" })).toBe(false);
  });
});

describe("worktreeSubject", () => {
  it("falls back to a short id when the worker has no name", () => {
    expect(worktreeSubject(session())).toBe("worker-one");
    expect(worktreeSubject(session({ name: undefined }))).toBe("11111111");
    expect(worktreeSubject(session({ name: "   " }))).toBe("11111111");
  });
});

describe("selectSession", () => {
  const one = session();
  const two = session({ id: "22222222-2222-4222-8222-222222222222", name: "worker-two" });

  it("matches an exact id or an exact name and nothing else", () => {
    expect(selectSession([one, two], two.id)).toBe(two);
    expect(selectSession([one, two], " worker-two ")).toBe(two);
    expect(() => selectSession([one, two], "worker")).toThrow(/No session matches/u);
  });

  it("refuses to guess between two workers sharing a name", () => {
    const clash = session({ id: "33333333-3333-4333-8333-333333333333", name: "worker-two" });
    let thrown: unknown;
    try {
      selectSession([two, clash], "worker-two");
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("SESSION_AMBIGUOUS");
    expect(String(thrown)).toContain(clash.id);
  });
});

describe("openWorktreeInNvim", () => {
  function tmuxAndNvim(): { calls: Array<{ command: string; args: string[] }>; spawnSync: SpawnSyncLike } {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync: SpawnSyncLike = (command, args) => {
      calls.push({ command, args });
      if (args[0] === "display-message") return { status: 0, stdout: "@4\n" };
      if (args[0] === "list-panes") return { status: 0, stdout: "%1\t0\tzsh\n%2\t0\tnvim\n" };
      return { status: 0, stdout: "ok:1\n" };
    };
    return { calls, spawnSync };
  }

  it("sends the worktree, its change list, and the live flag to the nvim in this window", async () => {
    const { calls, spawnSync } = tmuxAndNvim();

    const opened = await openWorktreeInNvim({
      session: session(),
      hostPaneId: "%1",
      spawnSync,
      uid: 501,
      worktreeExists: () => true,
      changes: async () => ({
        changes: [{ path: "src/a.ts", line: 7, text: "fn a() {" }],
        dropped: 0,
        baseline: FORK_POINT,
      }),
    });

    expect(opened).toEqual({
      sessionId: "11111111-1111-4111-8111-111111111111",
      worktree: "/work/tree",
      paneId: "%2",
      address: "/tmp/cyberdeck-nvim-501/pane-2.sock",
      entries: 1,
      live: true,
      baseline: FORK_POINT,
    });

    const nvimCall = calls.find(({ command }) => command === "nvim");
    expect(nvimCall?.args[1]).toBe("/tmp/cyberdeck-nvim-501/pane-2.sock");
    const payload = /\.open\('([A-Za-z0-9+/=]+)'\)$/u.exec(nvimCall?.args[3] ?? "")?.[1] ?? "";
    expect(decodeNvimPayload(payload)).toEqual({
      session: "11111111-1111-4111-8111-111111111111",
      worktree: "/work/tree",
      title: "Cyberdeck · worker-one · since origin/main",
      live: true,
      entries: [{ filename: "/work/tree/src/a.ts", lnum: 7, col: 1, text: "fn a() {" }],
    });
  });

  it("opens a finished worker's worktree without the read-only flag", async () => {
    const { spawnSync } = tmuxAndNvim();

    const opened = await openWorktreeInNvim({
      session: session({ executionState: "exited" }),
      hostPaneId: "%1",
      spawnSync,
      uid: 501,
      worktreeExists: () => true,
      changes: async () => ({ changes: [], dropped: 0, baseline: FORK_POINT }),
    });

    expect(opened.live).toBe(false);
    expect(opened.entries).toBe(0);
  });

  it("starts nvim in this window when there is none, before doing any git work", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync: SpawnSyncLike = (command, args) => {
      calls.push({ command, args });
      if (args[0] === "display-message") return { status: 0, stdout: "@4\n" };
      if (args[0] === "list-panes") {
        return args.includes("#{pane_id}\t#{pane_dead}\t#{pane_right}")
          ? { status: 0, stdout: "%1\t0\t79\n" }
          : { status: 0, stdout: "%1\t0\tzsh\n" };
      }
      if (args[0] === "split-window") return { status: 0, stdout: "%7\n" };
      return { status: 0, stdout: "ok:1\n" };
    };
    let collectedBeforeSpawn = false;

    const opened = await openWorktreeInNvim({
      session: session(),
      hostPaneId: "%1",
      spawnSync,
      uid: 501,
      worktreeExists: () => true,
      spawn: { socketExists: () => true },
      changes: async () => {
        collectedBeforeSpawn = !calls.some(({ args }) => args[0] === "split-window");
        return { changes: [], dropped: 0, baseline: FORK_POINT };
      },
    });

    expect(opened.paneId).toBe("%7");
    expect(opened.address).toBe("/tmp/cyberdeck-nvim-501/pane-7.sock");
    expect(collectedBeforeSpawn).toBe(false);
  });

  it("stops before any git work when the nvim it started never listens", async () => {
    let clock = 0;
    const spawnSync: SpawnSyncLike = (_command, args) => {
      if (args[0] === "display-message") return { status: 0, stdout: "@4\n" };
      if (args[0] === "list-panes") return { status: 0, stdout: "%1\t0\t79\n" };
      return { status: 0, stdout: "%7\n" };
    };
    let collected = false;

    await expect(openWorktreeInNvim({
      session: session(),
      hostPaneId: "%1",
      spawnSync,
      uid: 501,
      worktreeExists: () => true,
      spawn: {
        socketExists: () => false,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
        timeoutMs: 500,
      },
      changes: async () => {
        collected = true;
        return { changes: [], dropped: 0, baseline: FORK_POINT };
      },
    })).rejects.toThrow(/nothing was listening on/u);
    expect(collected).toBe(false);
  });

  it("refuses a worktree that is gone before it touches tmux at all", async () => {
    const { calls, spawnSync } = tmuxAndNvim();
    let thrown: unknown;

    try {
      await openWorktreeInNvim({
        session: session({ cwd: "/work/cleaned-up" }),
        hostPaneId: "%1",
        spawnSync,
        uid: 501,
        worktreeExists: () => false,
        changes: async () => ({ changes: [], dropped: 0, baseline: FORK_POINT }),
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("WORKTREE_MISSING");
    expect(String(thrown)).toContain("/work/cleaned-up");
    // Nothing was spawned and no pane was even looked for: an nvim started only to be told the
    // worktree is gone is a pane the operator now has to close by hand.
    expect(calls).toEqual([]);
  });

  it("opens a directory that is not a repository with an empty list that says so", async () => {
    const { spawnSync } = tmuxAndNvim();
    // A real directory and the real git path: the scratchpad threads this is about have a cwd that
    // was never `git init`-ed, and the answer has to come from git rather than from a stub.
    const scratch = mkdtempSync(join(tmpdir(), "cyberdeck-not-a-repo-"));

    try {
      const opened = await openWorktreeInNvim({
        session: session({ cwd: scratch }),
        hostPaneId: "%1",
        spawnSync,
        uid: 501,
      });

      expect(opened.entries).toBe(0);
      expect(opened.baseline).toEqual({ kind: "not-a-repo", label: "not a git repository" });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
