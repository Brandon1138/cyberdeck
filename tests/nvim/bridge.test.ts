import { describe, expect, it } from "vitest";
import { callNvim, remoteExprArgs } from "../../src/nvim/bridge.js";
import { encodeNvimPayload, type NvimWorktreeRequest } from "../../src/nvim/quickfix.js";
import type { SpawnSyncLike } from "../../src/tmux/cockpit.js";

const request: NvimWorktreeRequest = {
  session: "11111111-1111-4111-8111-111111111111",
  worktree: "/work/tree",
  title: "Cyberdeck · scout-7",
  live: true,
  baseline: { kind: "fork-point", label: "since origin/main", rev: "abc123" },
  entries: [{ filename: "/work/tree/a.ts", lnum: 3, col: 1, text: "changed" }],
};

describe("remoteExprArgs", () => {
  it("calls one function instead of sending keystrokes", () => {
    const args = remoteExprArgs("/tmp/sock", "open", "PAYLOAD");

    expect(args).toEqual([
      "--server", "/tmp/sock",
      "--remote-expr", "v:lua.require'cyberdeck'.open('PAYLOAD')",
    ]);
    // --remote-send would depend on the operator's current mode and mappings.
    expect(args).not.toContain("--remote-send");
  });
});

describe("callNvim", () => {
  it("passes the encoded request to nvim and returns its answer", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync: SpawnSyncLike = (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "ok:1\n" };
    };

    expect(callNvim({ address: "/tmp/sock", entryPoint: "open", request, spawnSync })).toBe("ok:1");
    expect(calls).toEqual([{
      command: "nvim",
      args: remoteExprArgs("/tmp/sock", "open", encodeNvimPayload(request)),
    }]);
  });

  it("tells the operator to call listen() when nothing answered on the socket", () => {
    const spawnSync: SpawnSyncLike = () => ({ status: 1, stdout: "" });
    let thrown: unknown;
    try {
      callNvim({ address: "/tmp/sock", entryPoint: "open", request, spawnSync });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("NVIM_NOT_SERVING");
    expect(String(thrown)).toMatch(/require\("cyberdeck"\)\.listen\(\)/u);
  });

  it("relays what the Lua module said when it refused", () => {
    const spawnSync: SpawnSyncLike = () => ({ status: 0, stdout: "error: worktree does not exist\n" });
    let thrown: unknown;
    try {
      callNvim({ address: "/tmp/sock", entryPoint: "refresh", request, spawnSync });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as { code?: string }).code).toBe("NVIM_REQUEST_REJECTED");
    expect(String(thrown)).toMatch(/worktree does not exist/u);
  });
});
