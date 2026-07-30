import { describe, expect, it } from "vitest";
import {
  decodeNvimPayload,
  encodeNvimPayload,
  quickfixEntries,
  worktreeRequest,
} from "../../src/nvim/quickfix.js";

describe("quickfixEntries", () => {
  it("resolves worktree-relative paths against the worktree Cyberdeck already knows", () => {
    const entries = quickfixEntries("/work/tree", {
      changes: [{ path: "src/a.ts", line: 12, text: "fn a() {" }],
      dropped: 0,
    });

    expect(entries).toEqual([
      { filename: "/work/tree/src/a.ts", lnum: 12, col: 1, text: "fn a() {" },
    ]);
  });
});

describe("worktreeRequest", () => {
  it("titles the list with the worker and carries the live flag", () => {
    const request = worktreeRequest({
      worktree: "/work/tree",
      subject: "scout-7",
      live: true,
      changes: { changes: [{ path: "a.ts", line: 1, text: "changed" }], dropped: 0 },
    });

    expect(request.title).toBe("Cyberdeck · scout-7");
    expect(request.live).toBe(true);
    expect(request.worktree).toBe("/work/tree");
    expect(request.entries).toHaveLength(1);
  });

  it("says in the title when the change set was truncated", () => {
    const request = worktreeRequest({
      worktree: "/work/tree",
      subject: "scout-7",
      live: false,
      changes: { changes: [], dropped: 12 },
    });

    expect(request.title).toBe("Cyberdeck · scout-7 (+12 more)");
  });
});

describe("encodeNvimPayload", () => {
  it("survives paths and context lines that would otherwise need escaping", () => {
    const request = worktreeRequest({
      worktree: "/work/it's a tree",
      subject: "a'b\"c",
      live: true,
      changes: {
        changes: [{ path: "src/a.ts", line: 1, text: "const s = 'x' + \"y\" + `z` \\ end" }],
        dropped: 0,
      },
    });
    const encoded = encodeNvimPayload(request);

    // A single Vim string literal is only safe if the payload cannot contain a quote at all.
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/u);
    expect(decodeNvimPayload(encoded)).toEqual(request);
  });
});
