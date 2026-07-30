import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { decodeNvimPayload } from "../../src/nvim/quickfix.js";
import {
  isWorkerLive,
  openWorktreeInNvim,
  selectSession,
  worktreeSubject,
} from "../../src/nvim/open-worktree.js";
import type { SpawnSyncLike } from "../../src/tmux/cockpit.js";

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
      changes: async () => ({ changes: [{ path: "src/a.ts", line: 7, text: "fn a() {" }], dropped: 0 }),
    });

    expect(opened).toEqual({
      sessionId: "11111111-1111-4111-8111-111111111111",
      worktree: "/work/tree",
      paneId: "%2",
      address: "/tmp/cyberdeck-nvim-501/pane-2.sock",
      entries: 1,
      live: true,
    });

    const nvimCall = calls.find(({ command }) => command === "nvim");
    expect(nvimCall?.args[1]).toBe("/tmp/cyberdeck-nvim-501/pane-2.sock");
    const payload = /\.open\('([A-Za-z0-9+/=]+)'\)$/u.exec(nvimCall?.args[3] ?? "")?.[1] ?? "";
    expect(decodeNvimPayload(payload)).toEqual({
      session: "11111111-1111-4111-8111-111111111111",
      worktree: "/work/tree",
      title: "Cyberdeck · worker-one",
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
      changes: async () => ({ changes: [], dropped: 0 }),
    });

    expect(opened.live).toBe(false);
    expect(opened.entries).toBe(0);
  });

  it("fails on a missing nvim before doing any git work", async () => {
    const spawnSync: SpawnSyncLike = (_command, args) =>
      args[0] === "display-message"
        ? { status: 0, stdout: "@4\n" }
        : { status: 0, stdout: "%1\t0\tzsh\n" };
    let collected = false;

    await expect(openWorktreeInNvim({
      session: session(),
      hostPaneId: "%1",
      spawnSync,
      uid: 501,
      changes: async () => {
        collected = true;
        return { changes: [], dropped: 0 };
      },
    })).rejects.toThrow(/No nvim in this tmux window/u);
    expect(collected).toBe(false);
  });
});
