import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("passes a new thread's initial task as one positional argument", () => {
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(
      session({ provider: "claude", name: "proof", model: "sonnet" }),
      "Inspect the failure\nthen fix it",
    );
    expect(spec.args.slice(-2)).toEqual(["--", "Inspect the failure\nthen fix it"]);
  });

  it("encodes one logical submit using Claude's terminal Enter key", () => {
    expect(new ClaudeProviderAdapter().submitInput("ping").toString("utf8")).toBe("ping\r");
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
