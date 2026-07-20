import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    provider: "codex",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "read-only",
    createdAt: now,
    updatedAt: now,
    executionState: "active",
    attachmentState: "detached",
    pid: 123,
    exitCode: null,
    childIds: [],
    ...overrides,
  };
}

describe("CodexProviderAdapter", () => {
  it("builds an interactive command without choosing a model", () => {
    const spec = new CodexProviderAdapter().buildLaunchSpec(session());
    expect(spec.executable).toBe("codex");
    expect(spec.args).toEqual([
      "--no-alt-screen",
      "-C",
      "/tmp/repo",
      "-s",
      "read-only",
      "-a",
      "on-request",
    ]);
  });

  it("adds the explicitly supplied model", () => {
    const spec = new CodexProviderAdapter().buildLaunchSpec(session({ model: "opus" }));
    expect(spec.args).toContain("-m");
    expect(spec.args).toContain("opus");
  });
});

describe("ClaudeProviderAdapter", () => {
  it.each([
    ["read-only", "plan"],
    ["workspace-write", "manual"],
  ] as const)("maps %s to %s without choosing a model", (sandbox, permissionMode) => {
    const record = session({ provider: "claude", sandbox, name: "proof" });
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(record);
    expect(spec.executable).toBe("claude");
    expect(spec.args).toEqual([
      "--session-id",
      record.id,
      "--name",
      "proof",
      "--permission-mode",
      permissionMode,
    ]);
    expect(spec.env.DISABLE_UPDATES).toBe("1");
  });

  it("adds only an explicitly supplied model", () => {
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(
      session({ provider: "claude", name: "proof", model: "sonnet" }),
    );
    expect(spec.args.slice(-2)).toEqual(["--model", "sonnet"]);
  });
});
