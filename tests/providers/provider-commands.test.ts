import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { ClaudeProviderAdapter } from "../../src/providers/claude.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import { CursorProviderAdapter } from "../../src/providers/cursor/session-adapter.js";
import { AntigravityProviderAdapter } from "../../src/providers/antigravity/session-adapter.js";

const CHILD_SOURCE: NodeJS.ProcessEnv = {
  PATH: "/source/provider-bin",
  UNRELATED_SENTINEL: "drop-this",
  TMUX: "drop-this",
  TMUX_PANE: "drop-this",
};

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

  it("maps explicit auto approval mode to Codex never while preserving the sandbox", () => {
    const spec = new CodexProviderAdapter().buildLaunchSpec(session({
      sandbox: "workspace-write",
      approvalMode: "auto",
    }));
    expect(spec.args).toEqual([
      "--no-alt-screen",
      "-C",
      "/tmp/repo",
      "-s",
      "workspace-write",
      "-a",
      "never",
    ]);
  });

  it("marks worker mode after sanitizing the source environment", () => {
    const spec = new CodexProviderAdapter({
      sourceEnvironment: CHILD_SOURCE,
    }).buildLaunchSpec(session({
      kind: "worker",
      workerMode: "caveman",
    }));
    expect(spec.env).toMatchObject({
      PATH: CHILD_SOURCE.PATH,
      PWD: "/tmp/repo",
      TERM: "xterm-256color",
      CYBERDECK_PROCESS_ROLE: "worker",
      CYBERDECK_WORKER_MODE: "caveman",
    });
    expect(spec.env.UNRELATED_SENTINEL).toBeUndefined();
    expect(spec.env.TMUX).toBeUndefined();
    expect(spec.env.TMUX_PANE).toBeUndefined();
  });

  it("starts an orchestrator with native developer instructions and MCP but no positional user prompt", () => {
    const mcp = { nodePath: "/node", cliPath: "/cyberdeck.js" };
    const orchestrator = session({
      kind: "orchestrator",
      sandbox: "workspace-write",
      approvalMode: "auto",
      providerInstructions: "Cyberdeck orchestrator guidance",
    });
    const spec = new CodexProviderAdapter({ mcp }).buildLaunchSpec(orchestrator);

    expect(spec.args).toContain("developer_instructions=\"Cyberdeck orchestrator guidance\"");
    expect(spec.args).toEqual(expect.arrayContaining([
      "--remote",
      "unix://",
      "model_provider=\"openai\"",
      "--approve-for-me",
    ]));
    expect(spec.args).not.toContain("-a");
    expect(spec.args.join(" ")).toContain("mcp_servers.cyberdeck.command");
    expect(spec.args.join(" ")).toContain(orchestrator.id);
    expect(spec.args).not.toContain("--");
    expect(new CodexProviderAdapter({ mcp }).buildLaunchSpec(session()).args.join(" "))
      .not.toContain("mcp_servers.cyberdeck");
  });

  it("starts the managed Remote Control daemon before an orchestrator connects", async () => {
    const runCommand = vi.fn(async () => undefined);
    const orchestrator = session({
      kind: "orchestrator",
      sandbox: "workspace-write",
      approvalMode: "auto",
    });
    const adapter = new CodexProviderAdapter({ runCommand });
    const spec = adapter.buildLaunchSpec(orchestrator);

    await adapter.prepareLaunch(orchestrator, spec);

    expect(runCommand).toHaveBeenCalledWith(
      "codex",
      ["remote-control", "start", "--json"],
      { cwd: "/tmp/repo", env: spec.env },
    );
  });

  it("fails an orchestrator launch loudly when Remote Control cannot start", async () => {
    const commandError = Object.assign(new Error("Command failed"), {
      stderr: "managed standalone Codex install not found at /managed/codex",
    });
    const adapter = new CodexProviderAdapter({
      runCommand: vi.fn(async () => { throw commandError; }),
    });
    const orchestrator = session({
      kind: "orchestrator",
      sandbox: "workspace-write",
      approvalMode: "auto",
    });

    await expect(adapter.prepareLaunch(orchestrator, adapter.buildLaunchSpec(orchestrator)))
      .rejects.toMatchObject({
        code: "CODEX_REMOTE_CONTROL_UNAVAILABLE",
        message: expect.stringContaining("managed standalone Codex install not found"),
      });
  });

  it("keeps workers on the direct CLI and never starts Remote Control", async () => {
    const runCommand = vi.fn(async () => undefined);
    const worker = session({
      kind: "worker",
      sandbox: "workspace-write",
      approvalMode: "auto",
    });
    const adapter = new CodexProviderAdapter({ runCommand });
    const spec = adapter.buildLaunchSpec(worker);

    await adapter.prepareLaunch(worker, spec);

    expect(spec.args).not.toContain("--remote");
    expect(spec.args).toEqual(expect.arrayContaining(["-s", "workspace-write", "-a", "never"]));
    expect(spec.args).not.toContain("--approve-for-me");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("passes a new thread's initial task as one positional argument", () => {
    const spec = new CodexProviderAdapter().buildLaunchSpec(session(), "Inspect the failure\nthen fix it");
    expect(spec.args.slice(-2)).toEqual(["--", "Inspect the failure\nthen fix it"]);
  });

  // MIK-78. `-i` is what makes this an attachment rather than a prompt that names a file, and it
  // attaches to the initial prompt, so the flags land before the `--` that ends the arguments.
  it("attaches declared images with the CLI's own image flag, ahead of the initial prompt", () => {
    const spec = new CodexProviderAdapter().buildLaunchSpec(
      session({ imageAttachments: ["/state/pasted-images/paste-a.png", "/tmp/b.png"] }),
      "Why is this misaligned?",
    );
    expect(spec.args.slice(-6)).toEqual([
      "-i",
      "/state/pasted-images/paste-a.png",
      "-i",
      "/tmp/b.png",
      "--",
      "Why is this misaligned?",
    ]);
  });

  it("attaches nothing when the session declared no image", () => {
    expect(new CodexProviderAdapter().buildLaunchSpec(session()).args).not.toContain("-i");
  });

  // A resume has no initial prompt left to attach to, and re-attaching a launch's image to every
  // later turn would put an image in front of the model that the operator never sent again.
  it("never re-attaches a launch image on resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-codex-resume-"));
    const nativeId = "019f86e4-16e4-7c61-9ee7-76b8b83b1018";
    const day = join(root, "2026", "07", "22");
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

    const spec = new CodexProviderAdapter({ sessionsDirectory: root }).buildResumeSpec(session({
      createdAt: "2026-07-21T22:55:21.806Z",
      imageAttachments: ["/state/pasted-images/paste-a.png"],
    }));

    expect(spec.args).not.toContain("-i");
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
      sourceEnvironment: CHILD_SOURCE,
    }).buildResumeSpec(session({
      createdAt,
      executionState: "exited",
      exitCode: 0,
      model: "gpt-test",
      kind: "orchestrator",
      sandbox: "workspace-write",
      approvalMode: "auto",
      providerInstructions: "Cyberdeck orchestrator guidance",
    }));

    expect(spec.executable).toBe("codex");
    expect(spec.args).toEqual([
      "resume",
      "--no-alt-screen",
      "-C",
      "/tmp/repo",
      "--remote",
      "unix://",
      "-c",
      "model_provider=\"openai\"",
      "--approve-for-me",
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
    expect(spec.env.PATH).toBe(CHILD_SOURCE.PATH);
    expect(spec.env.PWD).toBe("/tmp/repo");
    expect(spec.env.TERM).toBe("xterm-256color");
    expect(spec.env.UNRELATED_SENTINEL).toBeUndefined();
  });
});

// Claude's launch safety, headless path, and stream decoding are covered in depth by
// tests/providers/claude-adapter.test.ts. This block keeps the side-by-side command-construction
// comparison with Codex only.
describe("ClaudeProviderAdapter", () => {
  it("marks orchestrators normal even when the broker inherited stale worker metadata", () => {
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(session({
      provider: "claude",
      model: "sonnet",
      kind: "orchestrator",
    }));
    expect(spec.env).toMatchObject({
      CYBERDECK_PROCESS_ROLE: "orchestrator",
      CYBERDECK_WORKER_MODE: "normal",
    });
  });

  it("starts an orchestrator with native system instructions and MCP but no positional user prompt", () => {
    const orchestrator = session({
      provider: "claude",
      model: "opus",
      kind: "orchestrator",
      providerInstructions: "Cyberdeck orchestrator guidance",
    });
    const spec = new ClaudeProviderAdapter({ mcp: { nodePath: "/node", cliPath: "/cyberdeck.js" } })
      .buildLaunchSpec(orchestrator);

    expect(spec.args).toContain("--append-system-prompt-file");
    expect(spec.args).not.toContain("Cyberdeck orchestrator guidance");
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
      "--disallowedTools",
      "Agent,Task",
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

  it("maps explicit auto approval mode for Claude Opus without using a bypass mode", () => {
    const spec = new ClaudeProviderAdapter().buildLaunchSpec(session({
      provider: "claude",
      model: "opus",
      sandbox: "workspace-write",
      approvalMode: "auto",
    }));
    expect(spec.args).toContain("auto");
    expect(spec.args).not.toContain("manual");
    expect(spec.args).not.toContain("bypassPermissions");
    expect(spec.args).not.toContain("dontAsk");
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
      "--disallowedTools",
      // Orchestrators drop user scope, so the operator's denials are re-asserted here instead.
      "Agent,Task,Skill(update-config)",
      "--model",
      "haiku",
      "--append-system-prompt-file",
      expect.stringContaining(record.id),
      "--setting-sources",
      "project,local",
      "--mcp-config",
      expect.stringContaining(record.id),
      "--strict-mcp-config",
    ]);
  });
});

describe("workspace writable roots", () => {
  const workspace = {
    worktreePath: "/tmp/repo/worktrees/mik-70",
    branch: "brandon/mik-70",
    baseRef: "main",
    provisioning: "worker-provisioned" as const,
    writableRoots: ["/tmp/repo/.git", "/tmp/repo/worktrees/mik-70"],
  };

  /** Every `--add-dir` value in emission order, so a mispaired grant cannot pass as a present one. */
  function addDirValues(args: readonly string[]): string[] {
    return args.flatMap((arg, index) => (arg === "--add-dir" ? [args[index + 1]!] : []));
  }

  it.each([
    ["codex", new CodexProviderAdapter(), undefined],
    ["claude", new ClaudeProviderAdapter(), "sonnet"],
    ["cursor", new CursorProviderAdapter(), "composer"],
  ] as const)("grants %s the worktree it was dispatched to create", (provider, adapter, model) => {
    // The worker starts in /tmp/repo, not in the worktree it is about to add, so the target is
    // covered by neither cwd nor any other root. Without this grant `git worktree add` cannot
    // create the directory the dispatch named.
    const spec = adapter.buildLaunchSpec(session({
      provider,
      sandbox: "workspace-write",
      ...(model === undefined ? {} : { model }),
      workspace,
    }));
    expect(addDirValues(spec.args)).toEqual(["/tmp/repo/.git", "/tmp/repo/worktrees/mik-70"]);
  });

  it("does not re-grant a pre-provisioned worktree the session already runs in", () => {
    const spec = new CodexProviderAdapter().buildLaunchSpec(session({
      cwd: "/tmp/repo/worktrees/mik-70",
      sandbox: "workspace-write",
      workspace: {
        ...workspace,
        provisioning: "pre-provisioned",
        writableRoots: ["/tmp/repo/worktrees/mik-70"],
      },
    }));
    expect(addDirValues(spec.args)).toEqual([]);
  });
});

describe("strict MCP isolation", () => {
  it("bounds every Claude worker launch and no other provider's", () => {
    // The flags are Claude CLI surface. Codex configures MCP through `-c mcp_servers.*` and the
    // other two have their own isolation, so borrowing Claude's argv onto them would be invented.
    const mcp = { nodePath: "/node", cliPath: "/cyberdeck.js" };
    const claude = new ClaudeProviderAdapter({ mcp });
    for (const spec of [
      claude.buildLaunchSpec(session({ provider: "claude", model: "sonnet", kind: "worker" })),
      claude.buildResumeSpec(session({ provider: "claude", model: "sonnet", kind: "worker" })),
    ]) {
      expect(spec.args).toContain("--mcp-config");
      expect(spec.args).toContain("--strict-mcp-config");
    }

    const others = [
      new CodexProviderAdapter({ mcp }).buildLaunchSpec(session({ kind: "worker" })),
      new CursorProviderAdapter().buildLaunchSpec(
        session({ provider: "cursor", model: "composer", kind: "worker" }),
      ),
      new AntigravityProviderAdapter().buildLaunchSpec(
        session({
          provider: "antigravity",
          model: "gemini-3.6-flash-low",
          effort: "low",
          kind: "worker",
        }),
      ),
    ];
    for (const spec of others) {
      expect(spec.args).not.toContain("--strict-mcp-config");
      expect(spec.args).not.toContain("--mcp-config");
    }
  });
});

describe("extended interactive provider adapters", () => {
  it.each([
    ["claude", new ClaudeProviderAdapter({ sourceEnvironment: CHILD_SOURCE }), "sonnet"],
    ["cursor", new CursorProviderAdapter({ sourceEnvironment: CHILD_SOURCE }), "composer"],
    [
      "antigravity",
      new AntigravityProviderAdapter({ sourceEnvironment: CHILD_SOURCE }),
      "gemini-3.6-flash-low",
    ],
  ] as const)("sanitizes %s interactive child environment", (provider, adapter, model) => {
    const spec = adapter.buildLaunchSpec(session({
      provider,
      model,
      ...(provider === "antigravity" ? { effort: "low" as const } : {}),
    }));
    expect(spec.env).toMatchObject({
      PATH: CHILD_SOURCE.PATH,
      PWD: "/tmp/repo",
      TERM: "xterm-256color",
    });
    expect(spec.env.UNRELATED_SENTINEL).toBeUndefined();
    expect(spec.env.TMUX).toBeUndefined();
    expect(spec.env.TMUX_PANE).toBeUndefined();
  });

  it("defers Cursor auto mode to verified post-launch setup", () => {
    const adapter = new CursorProviderAdapter();
    const record = session({
      provider: "cursor",
      model: "composer",
      approvalMode: "auto",
      sandbox: "workspace-write",
    });
    expect(adapter.buildLaunchSpec(record).args).not.toContain("/run-everything");
    expect(adapter.deferInitialPrompt(record)).toBe(true);
  });

  it("withholds /run-everything from a read-only Cursor session that asked for auto", () => {
    const adapter = new CursorProviderAdapter();
    const record = session({ provider: "cursor", model: "composer", approvalMode: "auto" });
    // `/run-everything` is not bounded by `--mode plan`, so granting it here would widen the
    // read-only request exactly as Claude's `--permission-mode auto` used to.
    expect(adapter.buildLaunchSpec(record).args).toEqual(
      expect.arrayContaining(["--mode", "plan"]),
    );
    expect(adapter.deferInitialPrompt(record)).toBe(false);
  });

  it("accepts and submits pasted Cursor input with paced Enter keypresses", async () => {
    const writes: string[] = [];
    const waits: number[] = [];
    await new CursorProviderAdapter({ inputCommitDelayMs: 7 }).submitInputToTerminal(
      "Inspect HistoryView",
      {
        snapshot: () => Buffer.alloc(0),
        write: (data) => writes.push(data.toString("utf8")),
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
    );
    expect(writes).toEqual(["Inspect HistoryView", "\r", "\r"]);
    expect(waits).toEqual([7]);
  });

  it.each([
    ["antigravity", () => new AntigravityProviderAdapter().buildLaunchSpec(
      session({
        provider: "antigravity",
        model: "gemini-3.6-flash-low",
        effort: "low",
        approvalMode: "auto",
      }),
    )],
  ] as const)("fails clearly when %s is asked for unsupported auto approval", (_provider, build) => {
    expect(build).toThrow(expect.objectContaining({ code: "APPROVAL_MODE_NOT_SUPPORTED" }));
  });

  it("starts Cursor Composer with the exact initial prompt, explicit model, and bound chat id", () => {
    const adapter = new CursorProviderAdapter();
    const record = session({ provider: "cursor", model: "composer" });
    const spec = adapter.buildLaunchSpec(record, "Return eight bits");

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
      "--resume",
      record.id,
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
