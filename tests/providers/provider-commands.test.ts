import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import { CursorProviderAdapter } from "../../src/providers/cursor/session-adapter.js";
import { AntigravityProviderAdapter } from "../../src/providers/antigravity/session-adapter.js";

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

  it("forwards explicit reasoning effort through native Codex config", () => {
    const spec = new CodexProviderAdapter().buildLaunchSpec(session({ effort: "xhigh" }));
    expect(spec.args).toContain("model_reasoning_effort=\"xhigh\"");
  });

  it("starts an orchestrator with native developer instructions and MCP but no positional user prompt", () => {
    const mcp = { nodePath: "/node", cliPath: "/cyberdeck.js" };
    const orchestrator = session({
      kind: "orchestrator",
      providerInstructions: "Cyberdeck orchestrator guidance",
    });
    const spec = new CodexProviderAdapter({ mcp }).buildLaunchSpec(orchestrator);

    expect(spec.args).toContain("developer_instructions=\"Cyberdeck orchestrator guidance\"");
    expect(spec.args.join(" ")).toContain("mcp_servers.cyberdeck.command");
    expect(spec.args.join(" ")).toContain(orchestrator.id);
    expect(spec.args).not.toContain("--");
    expect(new CodexProviderAdapter({ mcp }).buildLaunchSpec(session()).args.join(" "))
      .not.toContain("mcp_servers.cyberdeck");
  });

  it("passes a new thread's initial task as one positional argument", () => {
    const spec = new CodexProviderAdapter().buildLaunchSpec(session(), "Inspect the failure\nthen fix it");
    expect(spec.args.slice(-2)).toEqual(["--", "Inspect the failure\nthen fix it"]);
  });

  it("encodes one logical submit using Codex's negotiated terminal Enter key", () => {
    expect(new CodexProviderAdapter().submitInput("ping").toString("utf8"))
      .toBe("ping\u001b[13u");
  });

  it("resumes the exact Codex conversation resolved from native session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-codex-sessions-"));
    const createdAt = "2026-07-21T22:55:21.806Z";
    const day = join(root, "2026", "07", "22");
    const nativeId = "019f86e4-16e4-7c61-9ee7-76b8b83b1017";
    await mkdir(day, { recursive: true });
    await writeFile(join(day, `rollout-${nativeId}.jsonl`), `${JSON.stringify({
      timestamp: "2026-07-21T22:55:22.866Z",
      type: "session_meta",
      payload: {
        id: nativeId,
        timestamp: "2026-07-21T22:55:22.866Z",
        cwd: "/tmp/repo",
        originator: "codex-tui",
      },
    })}\n`);

    const spec = new CodexProviderAdapter({
      sessionsDirectory: root,
      mcp: { nodePath: "/node", cliPath: "/cyberdeck.js" },
    }).buildResumeSpec(session({
      createdAt,
      executionState: "exited",
      exitCode: 0,
      model: "gpt-test",
      kind: "orchestrator",
      providerInstructions: "Cyberdeck orchestrator guidance",
    }));

    expect(spec.executable).toBe("codex");
    expect(spec.args).toEqual([
      "resume",
      "--no-alt-screen",
      "-C",
      "/tmp/repo",
      "-s",
      "read-only",
      "-a",
      "on-request",
      "-m",
      "gpt-test",
      "-c",
      "developer_instructions=\"Cyberdeck orchestrator guidance\"",
      "-c",
      "mcp_servers.cyberdeck.command=\"/node\"",
      "-c",
      expect.stringContaining("mcp_servers.cyberdeck.args="),
      nativeId,
    ]);
  });
});

// Claude's launch safety, headless path, and stream decoding are covered in depth by
// tests/providers/claude-adapter.test.ts. This block keeps the side-by-side command-construction
// comparison with Codex only.
describe("ClaudeProviderAdapter", () => {
  it("starts an orchestrator with native system instructions and MCP but no positional user prompt", () => {
    const orchestrator = session({
      provider: "claude",
      model: "opus",
      kind: "orchestrator",
      providerInstructions: "Cyberdeck orchestrator guidance",
    });
    const spec = new ClaudeProviderAdapter({ mcp: { nodePath: "/node", cliPath: "/cyberdeck.js" } })
      .buildLaunchSpec(orchestrator);

    expect(spec.args).toContain("--append-system-prompt");
    expect(spec.args).toContain("Cyberdeck orchestrator guidance");
    expect(spec.args).toContain("--mcp-config");
    expect(spec.args.join(" ")).toContain(orchestrator.id);
    expect(spec.args).not.toContain("--");
  });

  it.each([
    ["read-only", "plan"],
    ["workspace-write", "manual"],
  ] as const)("maps %s to %s without choosing a model", (sandbox, permissionMode) => {
    // A model must be supplied explicitly: unlike Codex, a Claude launch with an omitted model is
    // refused outright, because the recorded native default displayed Fable.
    const record = session({ provider: "claude", sandbox, name: "proof", model: "sonnet" });
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(record);
    expect(spec.executable).toBe("claude");
    expect(spec.args).toEqual([
      "--session-id",
      record.id,
      "--name",
      "proof",
      "--permission-mode",
      permissionMode,
      "--model",
      "sonnet",
    ]);
    expect(spec.env.DISABLE_UPDATES).toBe("1");
  });

  it("forwards only the explicitly supplied model", () => {
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(
      session({ provider: "claude", name: "proof", model: "sonnet" }),
    );
    expect(spec.args.slice(-2)).toEqual(["--model", "sonnet"]);
  });

  it("forwards explicit Claude effort on launch and resume", () => {
    const record = session({
      provider: "claude",
      name: "proof",
      model: "sonnet",
      effort: "high",
      executionState: "cancelled",
      exitCode: 0,
    });
    expect(new ClaudeProviderAdapter().buildLaunchSpec(record).args).toContain("--effort");
    expect(new ClaudeProviderAdapter().buildLaunchSpec(record).args).toContain("high");
    expect(new ClaudeProviderAdapter().buildResumeSpec(record).args).toContain("--effort");
  });

  it("passes a new thread's initial task as one positional argument", () => {
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(
      session({ provider: "claude", name: "proof", model: "sonnet" }),
      "Inspect the failure\nthen fix it",
    );
    expect(spec.args.slice(-2)).toEqual(["--", "Inspect the failure\nthen fix it"]);
  });

  it("encodes one logical submit using Claude's terminal Enter key", () => {
    expect(new ClaudeProviderAdapter().submitInput("ping").toString("utf8"))
      .toBe("ping\u001b[13u");
  });

  it("resumes the exact Claude conversation using the UUID Cyberdeck assigned at launch", () => {
    const record = session({
      provider: "claude",
      name: "claude-haiku-ping",
      model: "haiku",
      kind: "orchestrator",
      providerInstructions: "Cyberdeck orchestrator guidance",
      executionState: "cancelled",
      exitCode: 129,
    });
    const spec = new ClaudeProviderAdapter({ mcp: { nodePath: "/node", cliPath: "/cyberdeck.js" } })
      .buildResumeSpec(record);

    expect(spec.executable).toBe("claude");
    expect(spec.args).toEqual([
      "--resume",
      record.id,
      "--name",
      "claude-haiku-ping",
      "--permission-mode",
      "plan",
      "--model",
      "haiku",
      "--append-system-prompt",
      "Cyberdeck orchestrator guidance",
      "--mcp-config",
      expect.stringContaining(record.id),
    ]);
  });
});

describe("extended interactive provider adapters", () => {
  it("starts Cursor Composer with the exact initial prompt and explicit model", () => {
    const adapter = new CursorProviderAdapter();
    const spec = adapter.buildLaunchSpec(
      session({ provider: "cursor", model: "composer" }),
      "Return eight bits",
    );

    expect(spec.executable).toBe("agent");
    expect(spec.args).toEqual([
      "--workspace",
      "/tmp/repo",
      "--sandbox",
      "enabled",
      "--mode",
      "plan",
      "--model",
      "composer",
      "Return eight bits",
    ]);
  });

  it("starts Antigravity with the exact initial prompt and Gemini model", () => {
    const adapter = new AntigravityProviderAdapter();
    const spec = adapter.buildLaunchSpec(
      session({ provider: "antigravity", model: "gemini-3.6-flash-low", effort: "low" }),
      "Return eight bits",
    );

    expect(spec.executable).toBe("agy");
    expect(spec.args).toEqual([
      "--prompt-interactive",
      "Return eight bits",
      "--mode",
      "plan",
      "--sandbox",
      "--model",
      "gemini-3.6-flash-low",
      "--effort",
      "low",
    ]);
  });

  it.each([
    ["cursor", new CursorProviderAdapter()],
    ["antigravity", new AntigravityProviderAdapter()],
  ] as const)("fails %s resume explicitly rather than creating a new conversation", (_provider, adapter) => {
    expect(() => adapter.buildResumeSpec(session({ provider: adapter.id }))).toThrow(
      expect.objectContaining({ code: "SESSION_RESUME_UNAVAILABLE" }),
    );
  });
});
