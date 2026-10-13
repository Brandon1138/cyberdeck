import { describe, expect, it } from "vitest";
import {
  ANSWERABLE_MODAL_KINDS,
  describeBlockedModal,
  modalAnswerKeySequence,
  SCOPED_MODAL_ANSWERS,
  type ModalHookIdentity,
} from "../../src/domain/modal-descriptor.js";
import { BLOCKED_PROMPT_TAIL_CHARS } from "../../src/domain/terminal-replay.js";
import { WorkerTurnObservationAdapter } from "../../src/runtime/worker-turn-observation-adapter.js";
import {
  CLAUDE_LEGACY_TRUST,
  CLAUDE_TRUST,
  CLAUDE_TRUST_ACCESSIBLE,
  CLAUDE_TRUST_BACKSTOP,
  CLAUDE_TRUST_CAPTURED,
  CLAUDE_TRUST_WARNED,
  CODEX_DIRECTORY_TRUST,
  CODEX_FOLDER_ACCESS,
  CODEX_FOLDER_ACCESS_EXISTING_TASK,
  CODEX_FOLDER_ACCESS_KEEP_DIRECTORY,
  CODEX_FOLDER_ACCESS_RESTRICTED,
  CODEX_FOLDER_ACCESS_SUBDIRECTORY,
  CODEX_FOLDER_ACCESS_TRUST_ERROR,
  CODEX_HOOK_REVIEW,
  CODEX_HOOK_REVIEW_0_153,
  CODEX_HOOK_REVIEW_TRUSTING,
  codexRendered,
} from "../fixtures/provider-startup-dialogs.js";

const CLAUDE_PLAN_FRAME = [
  "Here is the implementation plan for the retry queue.",
  "",
  "Would you like to proceed?",
  "❯ 1. Yes, and auto-accept edits",
  "  2. Yes, and manually approve edits",
  "  3. No, keep planning",
].join("\r\n");

const CODEX_TRUST_FRAME = [
  "Welcome to Codex.",
  "Do you trust the contents of this project?",
  "/Users/op/repos/api",
  "> 1. Yes, allow Codex to work in this folder",
  "  2. No, ask me for approval every time",
].join("\r\n");

const CODEX_MCP_FRAME = [
  "Codex needs your approval to run this MCP tool call:",
  "  cyberdeck_report_progress",
  "❯ Yes, proceed",
  "  No, provide feedback (esc)",
].join("\r\n");

const CURSOR_TRUST_FRAME = [
  "┌ Workspace Trust Required ────────────────────┐",
  "│ Do you trust the files in this workspace?    │",
  "│ (a)ccept   (esc) dismiss                     │",
  "└──────────────────────────────────────────────┘",
].join("\r\n");

/** Exactly what the turn engine hands the descriptor: the replay digest's stripped tail. */
function replayed(raw: string): string {
  const replay = new WorkerTurnObservationAdapter().createReplay(128 * 1024);
  replay.appendBytes(Buffer.from(raw));
  return replay.strippedTail(BLOCKED_PROMPT_TAIL_CHARS).text;
}

function ids(provider: string, tail: string): string[] {
  return describeBlockedModal(provider, tail).answers.map((answer) => answer.id);
}

function keys(provider: string, tail: string): Record<string, string | undefined> {
  const descriptor = describeBlockedModal(provider, tail);
  return Object.fromEntries(descriptor.answers.map((answer) => [
    answer.id,
    modalAnswerKeySequence(provider, descriptor.kind, answer.id)?.toString(),
  ]));
}

function hook(key: string, currentHash: string, trustStatus: ModalHookIdentity["trustStatus"]) {
  return { key, currentHash, trustStatus };
}

describe("describeBlockedModal", () => {
  it("reads Claude's current folder-trust dialog, whose cancel row comes first", () => {
    const descriptor = describeBlockedModal("claude", CLAUDE_TRUST);
    expect(descriptor.kind).toBe("workspace-trust");
    expect(descriptor.answers).toEqual([
      { id: "trust", label: "Yes, I trust this folder" },
      { id: "exit", label: "No, exit" },
    ]);
    expect(keys("claude", CLAUDE_TRUST)).toEqual({ trust: "2", exit: "1" });
    expect(descriptor.evidence).toContain("/Users/op/repos/api/worktrees/fix-races");
    expect(descriptor.evidence.endsWith("Enter to confirm · Esc to cancel")).toBe(true);
    expect(descriptor.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("reads Claude's dialog as the replay keeps it, with every space lost to a cursor move", () => {
    const descriptor = describeBlockedModal("claude", replayed(CLAUDE_TRUST_CAPTURED));
    expect(descriptor.evidence).toContain("Quicksafetycheck:");
    expect(descriptor.kind).toBe("workspace-trust");
    // Labels are the provider's words, never the glued text the evidence carries.
    expect(descriptor.answers).toEqual([
      { id: "trust", label: "Yes, I trust this folder" },
      { id: "exit", label: "No, exit" },
    ]);
  });

  it("withholds trust when the folder's config would apply grants without asking", () => {
    expect(ids("claude", CLAUDE_TRUST_WARNED)).toEqual(["exit"]);
  });

  it("offers only declining the grants at Claude's backstop, never enabling them", () => {
    expect(describeBlockedModal("claude", CLAUDE_TRUST_BACKSTOP).answers).toEqual([
      { id: "continue-without-permissions", label: "No, continue without these permissions" },
    ]);
    expect(keys("claude", CLAUDE_TRUST_BACKSTOP)).toEqual({ "continue-without-permissions": "1" });
  });

  it("answers nothing when Claude's rows are not the ones the digits were checked against", () => {
    const reversed = CLAUDE_TRUST.replace(
      " ❯ No, exit\r\n   Yes, I trust this folder",
      " ❯ Yes, I trust this folder\r\n   No, exit",
    );
    expect(reversed).not.toBe(CLAUDE_TRUST);
    for (const frame of [CLAUDE_TRUST_ACCESSIBLE, reversed]) {
      const descriptor = describeBlockedModal("claude", frame);
      expect(descriptor.kind).toBe("workspace-trust");
      expect(descriptor.answers).toEqual([]);
    }
  });

  it("names Claude's older trust dialog but answers nothing: its rows run the other way", () => {
    const descriptor = describeBlockedModal("claude", CLAUDE_LEGACY_TRUST);
    expect(descriptor.kind).toBe("workspace-trust");
    expect(descriptor.answers).toEqual([]);
    expect(descriptor.evidence).toContain("Do you trust the files in this folder?");
  });

  it("classifies Claude's plan gate as plan-confirm, not permission-approval", () => {
    const descriptor = describeBlockedModal("claude", CLAUDE_PLAN_FRAME);
    expect(descriptor.kind).toBe("plan-confirm");
    expect(descriptor.answers.map((answer) => answer.id)).toEqual([
      "proceed-auto",
      "proceed-manual",
      "keep-planning",
    ]);
  });

  it("reads Codex's folder-access dialog however ratatui placed its words", () => {
    for (const tail of [
      CODEX_FOLDER_ACCESS,
      replayed(codexRendered(CODEX_FOLDER_ACCESS, "rows")),
      replayed(codexRendered(CODEX_FOLDER_ACCESS)),
    ]) {
      const descriptor = describeBlockedModal("codex", tail);
      expect(descriptor.kind).toBe("workspace-trust");
      expect(descriptor.answers).toEqual([
        { id: "trust", label: "Trust and continue" },
        { id: "decline", label: "Quit" },
      ]);
      expect(descriptor.evidence).toMatch(/\/workspace\/project/u);
    }
    expect(keys("codex", CODEX_FOLDER_ACCESS)).toEqual({ trust: "k\r", decline: "2" });
  });

  it("labels Codex's second row by what it does in each folder-access variant", () => {
    expect(describeBlockedModal("codex", CODEX_FOLDER_ACCESS_SUBDIRECTORY).answers[1])
      .toEqual({ id: "decline", label: "Back to Agent Command Center" });
    expect(describeBlockedModal("codex", CODEX_FOLDER_ACCESS_KEEP_DIRECTORY).answers[1])
      .toEqual({ id: "decline", label: "Keep current directory" });
    const failed = describeBlockedModal("codex", replayed(codexRendered(CODEX_FOLDER_ACCESS_TRUST_ERROR)));
    expect(failed.answers.map((answer) => answer.id)).toEqual(["trust", "decline"]);
    expect(failed.evidence).toContain("Failedtosettrust");
  });

  it("answers nothing at Codex's restricted variants, whose first row changes no saved trust", () => {
    for (const frame of [CODEX_FOLDER_ACCESS_RESTRICTED, CODEX_FOLDER_ACCESS_EXISTING_TASK]) {
      for (const tail of [frame, replayed(codexRendered(frame))]) {
        const descriptor = describeBlockedModal("codex", tail);
        expect(descriptor.kind).toBe("workspace-trust");
        expect(descriptor.answers).toEqual([]);
      }
    }
  });

  it("reads the directory-trust dialog Codex 0.120 through 0.153 draws", () => {
    const descriptor = describeBlockedModal("codex", replayed(codexRendered(CODEX_DIRECTORY_TRUST)));
    expect(descriptor.kind).toBe("workspace-trust");
    expect(descriptor.answers).toEqual([
      { id: "trust", label: "Yes, continue" },
      { id: "decline", label: "No, quit" },
    ]);
    expect(descriptor.evidence).toContain("/Users/op/repos/api");
  });

  it("reads Codex's older project-trust dialog with the folder it names", () => {
    const descriptor = describeBlockedModal("codex", CODEX_TRUST_FRAME);
    expect(descriptor.kind).toBe("workspace-trust");
    expect(descriptor.answers.map((answer) => answer.id)).toEqual(["trust", "ask-every-time"]);
    expect(descriptor.evidence).toContain("/Users/op/repos/api");
    expect(keys("codex", CODEX_TRUST_FRAME)).toEqual({ trust: "k\r", "ask-every-time": "2" });
  });

  it("reads Codex's hook review as its own kind, answerable only without the hooks", () => {
    for (const tail of [
      CODEX_HOOK_REVIEW,
      CODEX_HOOK_REVIEW_0_153,
      replayed(codexRendered(CODEX_HOOK_REVIEW)),
    ]) {
      const descriptor = describeBlockedModal("codex", tail);
      expect(descriptor.kind).toBe("hook-review");
      expect(descriptor.answers).toEqual([
        { id: "continue-without-hooks", label: "Continue without trusting (hooks won't run)" },
      ]);
    }
    expect(keys("codex", CODEX_HOOK_REVIEW)).toEqual({ "continue-without-hooks": "3" });
  });

  it("answers nothing while Codex is applying a trust-all the operator chose", () => {
    expect(ids("codex", CODEX_HOOK_REVIEW_TRUSTING)).toEqual([]);
  });

  it("attributes the hook review drawn after the folder-access dialog it follows", () => {
    const tail = replayed(codexRendered(CODEX_FOLDER_ACCESS) + codexRendered(CODEX_HOOK_REVIEW));
    expect(describeBlockedModal("codex", tail).kind).toBe("hook-review");
  });

  it("reclassifies a Codex approval that is about an MCP tool", () => {
    const descriptor = describeBlockedModal("codex", CODEX_MCP_FRAME);
    expect(descriptor.kind).toBe("mcp-approval");
    expect(descriptor.answers.map((answer) => answer.id)).toEqual(["approve", "deny"]);
  });

  it("reads Cursor's workspace-trust dialog — the MIK-141 incident shape", () => {
    const descriptor = describeBlockedModal("cursor", CURSOR_TRUST_FRAME);
    expect(descriptor.kind).toBe("workspace-trust");
    expect(descriptor.answers.map((answer) => answer.id)).toEqual(["trust", "dismiss"]);
    expect(modalAnswerKeySequence("cursor", "workspace-trust", "trust")?.toString()).toBe("a");
  });

  it("describes a login prompt with no answers at all", () => {
    const descriptor = describeBlockedModal(
      "cursor",
      "cursor-agent needs authentication. Run cursor-agent login to continue.",
    );
    expect(descriptor.kind).toBe("login");
    expect(descriptor.answers).toEqual([]);
  });

  it("falls back to an unanswerable unknown descriptor when nothing matches", () => {
    const descriptor = describeBlockedModal("claude", "Some dialog nobody has seen before\n[OK]");
    expect(descriptor.kind).toBe("unknown");
    expect(descriptor.answers).toEqual([]);
    expect(descriptor.evidence.length).toBeGreaterThan(0);
  });

  it("attributes the last-drawn dialog when older prompt text is still in the tail", () => {
    const tail = `${CLAUDE_TRUST}\r\n...answered, then later...\r\n${CLAUDE_PLAN_FRAME}`;
    expect(describeBlockedModal("claude", tail).kind).toBe("plan-confirm");
  });
});

describe("modal fingerprints", () => {
  it("stay stable across redraws and change with the folder a trust dialog names", () => {
    const first = describeBlockedModal("claude", CLAUDE_TRUST);
    const redrawn = describeBlockedModal("claude", `spinner noise\r\n${CLAUDE_TRUST}`);
    const other = describeBlockedModal("claude", CLAUDE_TRUST.replace("fix-races", "other"));
    expect(redrawn.fingerprint).toBe(first.fingerprint);
    expect(other.fingerprint).not.toBe(first.fingerprint);
    const codex = describeBlockedModal("codex", CODEX_FOLDER_ACCESS).fingerprint;
    expect(describeBlockedModal("codex", `${CODEX_FOLDER_ACCESS}\n› Ask Codex`).fingerprint).toBe(codex);
    expect(describeBlockedModal("codex", CODEX_FOLDER_ACCESS.replace("/workspace/project", "/workspace/other"))
      .fingerprint).not.toBe(codex);
  });

  it("change when the answer set a dialog offers changes", () => {
    const plain = describeBlockedModal("claude", CLAUDE_TRUST).fingerprint;
    expect(describeBlockedModal("claude", CLAUDE_TRUST_WARNED).fingerprint).not.toBe(plain);
    expect(describeBlockedModal("claude", CLAUDE_TRUST_BACKSTOP).fingerprint)
      .not.toBe(describeBlockedModal("claude", CLAUDE_TRUST_WARNED).fingerprint);
    expect(describeBlockedModal("codex", CODEX_FOLDER_ACCESS_KEEP_DIRECTORY).fingerprint)
      .not.toBe(describeBlockedModal("codex", CODEX_FOLDER_ACCESS).fingerprint);
  });

  it("change when the number of hooks under review changes", () => {
    expect(describeBlockedModal("codex", CODEX_HOOK_REVIEW.replace("2 hooks", "3 hooks")).fingerprint)
      .not.toBe(describeBlockedModal("codex", CODEX_HOOK_REVIEW).fingerprint);
  });
});

describe("hook identity", () => {
  const first = hook("/repo/.codex/hooks.json:pre_tool_use:0:0", "sha256:aaa", "untrusted");
  const second = hook("/repo/.codex/hooks.json:stop:0:0", "sha256:bbb", "untrusted");

  it("carries only the hooks under review, ordered by key, with nothing else they held", () => {
    const descriptor = describeBlockedModal("codex", CODEX_HOOK_REVIEW, {
      hooks: [
        second,
        hook("/home/.codex/hooks.json:stop:0:0", "sha256:ccc", "trusted"),
        hook("/etc/codex/hooks.json:stop:0:0", "sha256:ddd", "managed"),
        { ...first, sourcePath: "/repo/.codex/hooks.json" } as ModalHookIdentity,
      ],
    });
    expect(descriptor.hooks).toEqual([first, second]);
  });

  it("refuses an answer read before a previously approved hook changed", () => {
    // The operator trusted the hook at sha256:aaa; its command then changed. Codex reports it as
    // modified and asks again in exactly the same words — only the inventory tells them apart.
    const beforeApproval = describeBlockedModal("codex", CODEX_HOOK_REVIEW, { hooks: [first, second] });
    const afterChange = describeBlockedModal("codex", CODEX_HOOK_REVIEW, {
      hooks: [hook(first.key, "sha256:eee", "modified"), second],
    });
    expect(afterChange.evidence).toBe(beforeApproval.evidence);
    expect(afterChange.fingerprint).not.toBe(beforeApproval.fingerprint);
    const sameHashNewVerdict = describeBlockedModal("codex", CODEX_HOOK_REVIEW, {
      hooks: [hook(first.key, first.currentHash, "modified"), second],
    });
    expect(sameHashNewVerdict.fingerprint).not.toBe(beforeApproval.fingerprint);
  });

  it("leaves every fingerprint without an inventory as it was, and other kinds untouched", () => {
    const bare = describeBlockedModal("codex", CODEX_HOOK_REVIEW);
    expect(bare.hooks).toBeUndefined();
    expect(describeBlockedModal("codex", CODEX_HOOK_REVIEW, {}).fingerprint).toBe(bare.fingerprint);
    const trust = describeBlockedModal("codex", CODEX_FOLDER_ACCESS);
    const withInventory = describeBlockedModal("codex", CODEX_FOLDER_ACCESS, { hooks: [first] });
    expect(withInventory.hooks).toBeUndefined();
    expect(withInventory.fingerprint).toBe(trust.fingerprint);
  });
});

describe("modal answer key table", () => {
  const FIXTURES: readonly (readonly [string, string])[] = [
    ["claude", CLAUDE_TRUST],
    ["claude", CLAUDE_TRUST_WARNED],
    ["claude", CLAUDE_TRUST_BACKSTOP],
    ["claude", replayed(CLAUDE_TRUST_CAPTURED)],
    ["claude", CLAUDE_PLAN_FRAME],
    ["codex", CODEX_FOLDER_ACCESS],
    ["codex", CODEX_FOLDER_ACCESS_SUBDIRECTORY],
    ["codex", CODEX_FOLDER_ACCESS_KEEP_DIRECTORY],
    ["codex", replayed(codexRendered(CODEX_FOLDER_ACCESS_TRUST_ERROR))],
    ["codex", CODEX_DIRECTORY_TRUST],
    ["codex", CODEX_TRUST_FRAME],
    ["codex", CODEX_HOOK_REVIEW],
    ["codex", CODEX_HOOK_REVIEW_0_153],
    ["codex", CODEX_MCP_FRAME],
    ["cursor", CURSOR_TRUST_FRAME],
  ];

  it("gives every offered answer exactly one key sequence, distinct from its siblings'", () => {
    for (const [provider, tail] of FIXTURES) {
      const pressed = Object.values(keys(provider, tail));
      expect(pressed.length).toBeGreaterThan(0);
      expect(pressed).not.toContain(undefined);
      expect(new Set(pressed).size).toBe(pressed.length);
    }
  });

  it("resolves only enumerated (provider, kind, answer) triples", () => {
    expect(modalAnswerKeySequence("claude", "workspace-trust", "trust")?.toString()).toBe("2");
    expect(modalAnswerKeySequence("codex", "workspace-trust", "trust")?.toString()).toBe("k\r");
    expect(modalAnswerKeySequence("codex", "mcp-approval", "approve")?.toString()).toBe("\r");
    expect(modalAnswerKeySequence("claude", "workspace-trust", "rm -rf /")).toBeUndefined();
    expect(modalAnswerKeySequence("claude", "unknown", "trust")).toBeUndefined();
    expect(modalAnswerKeySequence("claude", "login", "anything")).toBeUndefined();
    for (const answer of ["2", "k\r", "\u001b", "Yes, I trust this folder"]) {
      expect(modalAnswerKeySequence("claude", "workspace-trust", answer)).toBeUndefined();
    }
  });

  it("has no key that reviews or trusts hooks", () => {
    for (const answer of ["trust", "trust-all", "review", "approve", "1", "2", "3", "Trust all and continue"]) {
      expect(modalAnswerKeySequence("codex", "hook-review", answer)).toBeUndefined();
    }
    for (const provider of ["claude", "cursor", "antigravity"]) {
      expect(modalAnswerKeySequence(provider, "hook-review", "continue-without-hooks")).toBeUndefined();
    }
  });

  it("policy never answers per-action approvals, logins, or unknowns, and scopes hook reviews", () => {
    expect(ANSWERABLE_MODAL_KINDS.has("workspace-trust")).toBe(true);
    expect(ANSWERABLE_MODAL_KINDS.has("hook-review")).toBe(true);
    expect(ANSWERABLE_MODAL_KINDS.has("mcp-approval")).toBe(true);
    expect(ANSWERABLE_MODAL_KINDS.has("plan-confirm")).toBe(true);
    expect(ANSWERABLE_MODAL_KINDS.has("permission-approval")).toBe(false);
    expect(ANSWERABLE_MODAL_KINDS.has("login")).toBe(false);
    expect(ANSWERABLE_MODAL_KINDS.has("unknown")).toBe(false);
    expect([...(SCOPED_MODAL_ANSWERS["hook-review"] ?? [])]).toEqual(["continue-without-hooks"]);
  });
});
