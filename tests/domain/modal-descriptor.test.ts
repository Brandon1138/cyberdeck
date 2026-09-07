import { describe, expect, it } from "vitest";
import {
  ANSWERABLE_MODAL_KINDS,
  describeBlockedModal,
  modalAnswerKeySequence,
} from "../../src/domain/modal-descriptor.js";

const CLAUDE_TRUST_FRAME = [
  "╭──────────────────────────────────────────────╮",
  "│ Do you trust the files in this folder?       │",
  "│                                              │",
  "│ /Users/op/repos/api/worktrees/fix-races      │",
  "│                                              │",
  "│ ❯ 1. Yes, proceed                            │",
  "│   2. No, exit                                │",
  "╰──────────────────────────────────────────────╯",
].join("\r\n");

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

describe("describeBlockedModal", () => {
  it("reads Claude's folder-trust dialog into an answerable descriptor", () => {
    const descriptor = describeBlockedModal("claude", CLAUDE_TRUST_FRAME);
    expect(descriptor.kind).toBe("workspace-trust");
    expect(descriptor.answers.map((answer) => answer.id)).toEqual(["trust", "exit"]);
    expect(descriptor.evidence).toContain("Do you trust the files in this folder?");
    expect(descriptor.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
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

  it("reads Codex's project-trust dialog", () => {
    const descriptor = describeBlockedModal("codex", CODEX_TRUST_FRAME);
    expect(descriptor.kind).toBe("workspace-trust");
    expect(descriptor.answers.map((answer) => answer.id)).toEqual(["trust", "ask-every-time"]);
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
    const tail = `${CLAUDE_TRUST_FRAME}\r\n...answered, then later...\r\n${CLAUDE_PLAN_FRAME}`;
    expect(describeBlockedModal("claude", tail).kind).toBe("plan-confirm");
  });

  it("keeps the fingerprint stable across redraws and distinct across dialogs", () => {
    const first = describeBlockedModal("claude", CLAUDE_TRUST_FRAME);
    const redrawn = describeBlockedModal("claude", `spinner noise\r\n${CLAUDE_TRUST_FRAME}`);
    const other = describeBlockedModal("claude", CLAUDE_TRUST_FRAME.replace("fix-races", "other"));
    expect(redrawn.fingerprint).toBe(first.fingerprint);
    expect(other.fingerprint).not.toBe(first.fingerprint);
  });
});

describe("modal answer key table", () => {
  it("resolves only enumerated (provider, kind, answer) triples", () => {
    expect(modalAnswerKeySequence("claude", "workspace-trust", "trust")?.toString()).toBe("1");
    expect(modalAnswerKeySequence("codex", "mcp-approval", "approve")?.toString()).toBe("\r");
    expect(modalAnswerKeySequence("claude", "workspace-trust", "rm -rf /")).toBeUndefined();
    expect(modalAnswerKeySequence("claude", "unknown", "trust")).toBeUndefined();
    expect(modalAnswerKeySequence("claude", "login", "anything")).toBeUndefined();
  });

  it("policy never answers per-action approvals, logins, or unknowns", () => {
    expect(ANSWERABLE_MODAL_KINDS.has("workspace-trust")).toBe(true);
    expect(ANSWERABLE_MODAL_KINDS.has("mcp-approval")).toBe(true);
    expect(ANSWERABLE_MODAL_KINDS.has("plan-confirm")).toBe(true);
    expect(ANSWERABLE_MODAL_KINDS.has("permission-approval")).toBe(false);
    expect(ANSWERABLE_MODAL_KINDS.has("login")).toBe(false);
    expect(ANSWERABLE_MODAL_KINDS.has("unknown")).toBe(false);
  });
});
