import { describe, expect, it } from "vitest";
import type { ApprovalMode, ProviderId, Sandbox } from "../../src/domain/session.js";
import {
  resolveEffectivePermission,
  resolveProviderPermissionPlan,
  type EffectivePermission,
} from "../../src/domain/permission-resolution.js";

const PROVIDERS: ProviderId[] = ["codex", "claude", "cursor", "antigravity"];
const SANDBOXES: Sandbox[] = ["read-only", "workspace-write"];
const APPROVAL_MODES: ApprovalMode[] = ["prompt", "auto"];

function plan(provider: ProviderId, sandbox: Sandbox, approvalMode?: ApprovalMode) {
  const result = resolveProviderPermissionPlan(provider, { sandbox, approvalMode });
  if (!result.ok) throw new Error(`${provider} refused ${sandbox}/${approvalMode}: ${result.code}`);
  return result.value;
}

describe("resolveEffectivePermission", () => {
  it("reads the sandbox as the write boundary and the approval mode as the prompt boundary", () => {
    expect(resolveEffectivePermission("read-only", "auto")).toEqual({
      writes: "denied",
      prompts: "never",
    });
    expect(resolveEffectivePermission("workspace-write", "prompt")).toEqual({
      writes: "workspace",
      prompts: "interactive",
    });
  });

  it("treats an omitted approval mode as prompt, never as auto", () => {
    expect(resolveEffectivePermission("workspace-write")).toEqual({
      writes: "workspace",
      prompts: "interactive",
    });
  });
});

describe("the cross-provider resolution parity table", () => {
  // The whole point of MIK-70: one stored request, one meaning. Every cell of this table is the
  // same `(sandbox, approvalMode)` pair read four ways, and the write boundary has to survive all
  // four readings intact.
  const table: Array<{
    provider: ProviderId;
    sandbox: Sandbox;
    approvalMode: ApprovalMode;
    args: string[];
    achieved: EffectivePermission;
    shortfalls: string[];
    postLaunch: string[];
  }> = [
    {
      provider: "codex",
      sandbox: "read-only",
      approvalMode: "prompt",
      args: ["-s", "read-only", "-a", "on-request"],
      achieved: { writes: "denied", prompts: "interactive" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "codex",
      sandbox: "read-only",
      approvalMode: "auto",
      args: ["-s", "read-only", "-a", "never"],
      achieved: { writes: "denied", prompts: "never" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "codex",
      sandbox: "workspace-write",
      approvalMode: "prompt",
      args: ["-s", "workspace-write", "-a", "on-request"],
      achieved: { writes: "workspace", prompts: "interactive" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "codex",
      sandbox: "workspace-write",
      approvalMode: "auto",
      args: ["-s", "workspace-write", "-a", "never"],
      achieved: { writes: "workspace", prompts: "never" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "claude",
      sandbox: "read-only",
      approvalMode: "prompt",
      args: ["--permission-mode", "plan"],
      achieved: { writes: "denied", prompts: "interactive" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "claude",
      sandbox: "read-only",
      approvalMode: "auto",
      args: ["--permission-mode", "plan"],
      achieved: { writes: "denied", prompts: "interactive" },
      shortfalls: ["APPROVAL_PROMPTS_REMAIN"],
      postLaunch: [],
    },
    {
      provider: "claude",
      sandbox: "workspace-write",
      approvalMode: "prompt",
      args: ["--permission-mode", "manual"],
      achieved: { writes: "workspace", prompts: "interactive" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "claude",
      sandbox: "workspace-write",
      approvalMode: "auto",
      args: ["--permission-mode", "auto"],
      achieved: { writes: "workspace", prompts: "never" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "cursor",
      sandbox: "read-only",
      approvalMode: "prompt",
      args: ["--sandbox", "enabled", "--mode", "plan"],
      achieved: { writes: "denied", prompts: "interactive" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "cursor",
      sandbox: "read-only",
      approvalMode: "auto",
      args: ["--sandbox", "enabled", "--mode", "plan"],
      achieved: { writes: "denied", prompts: "interactive" },
      shortfalls: ["APPROVAL_PROMPTS_REMAIN"],
      postLaunch: [],
    },
    {
      provider: "cursor",
      sandbox: "workspace-write",
      approvalMode: "prompt",
      args: ["--sandbox", "enabled"],
      achieved: { writes: "workspace", prompts: "interactive" },
      shortfalls: [],
      postLaunch: [],
    },
    {
      provider: "cursor",
      sandbox: "workspace-write",
      approvalMode: "auto",
      args: ["--sandbox", "enabled"],
      achieved: { writes: "workspace", prompts: "never" },
      shortfalls: [],
      postLaunch: ["cursor-run-everything"],
    },
    {
      provider: "antigravity",
      sandbox: "read-only",
      approvalMode: "prompt",
      args: ["--mode", "plan", "--sandbox"],
      achieved: { writes: "denied", prompts: "interactive" },
      shortfalls: [],
      postLaunch: [],
    },
  ];

  it.each(table)(
    "resolves $provider $sandbox/$approvalMode to $args",
    ({ provider, sandbox, approvalMode, args, achieved, shortfalls, postLaunch }) => {
      const resolved = plan(provider, sandbox, approvalMode);
      expect(resolved.args).toEqual(args);
      expect(resolved.achieved).toEqual(achieved);
      expect(resolved.shortfalls.map((shortfall) => shortfall.code)).toEqual(shortfalls);
      expect(resolved.postLaunch).toEqual(postLaunch);
    },
  );

  it("never lets a provider deliver a wider write boundary than the request asked for", () => {
    for (const provider of PROVIDERS) {
      for (const sandbox of SANDBOXES) {
        for (const approvalMode of APPROVAL_MODES) {
          const result = resolveProviderPermissionPlan(provider, { sandbox, approvalMode });
          if (!result.ok) continue;
          expect(result.value.achieved.writes).toBe(result.value.requested.writes);
        }
      }
    }
  });

  it("declares a shortfall whenever prompts fall back from the requested automatic approval", () => {
    for (const provider of PROVIDERS) {
      for (const sandbox of SANDBOXES) {
        const result = resolveProviderPermissionPlan(provider, { sandbox, approvalMode: "auto" });
        if (!result.ok) continue;
        const { achieved, requested, shortfalls } = result.value;
        if (achieved.prompts !== requested.prompts) {
          expect(shortfalls.map((shortfall) => shortfall.code)).toContain("APPROVAL_PROMPTS_REMAIN");
        }
      }
    }
  });
});

describe("the silent-widening regression", () => {
  // MIK-70. `--permission-mode auto` was emitted for any `approvalMode: "auto"` request, so the
  // stored request that reached Codex as `-s read-only -a never` reached Claude as a session that
  // could write. Nothing anywhere recorded that the two had diverged.
  it("keeps a read-only Claude request read-only even when it asks for automatic approval", () => {
    const resolved = plan("claude", "read-only", "auto");
    expect(resolved.args).toEqual(["--permission-mode", "plan"]);
    expect(resolved.args).not.toContain("auto");
    expect(resolved.achieved.writes).toBe("denied");
  });

  it("says out loud what the read-only Claude session gave up instead of widening", () => {
    const resolved = plan("claude", "read-only", "auto");
    expect(resolved.shortfalls).toHaveLength(1);
    expect(resolved.shortfalls[0]?.code).toBe("APPROVAL_PROMPTS_REMAIN");
    expect(resolved.shortfalls[0]?.message).toContain("plan");
  });

  it("resolves the identical stored request to the identical write boundary for Codex and Claude", () => {
    const codex = plan("codex", "read-only", "auto");
    const claude = plan("claude", "read-only", "auto");
    expect(codex.args).toEqual(["-s", "read-only", "-a", "never"]);
    expect(claude.achieved.writes).toBe(codex.achieved.writes);
    expect(claude.requested).toEqual(codex.requested);
  });

  it("withholds Cursor's /run-everything from a read-only session, which it does not bound", () => {
    const resolved = plan("cursor", "read-only", "auto");
    expect(resolved.postLaunch).toEqual([]);
    expect(resolved.shortfalls.map((shortfall) => shortfall.code))
      .toEqual(["APPROVAL_PROMPTS_REMAIN"]);
  });

  it("never emits Claude's write-unbounded permission modes", () => {
    for (const sandbox of SANDBOXES) {
      for (const approvalMode of APPROVAL_MODES) {
        const resolved = plan("claude", sandbox, approvalMode);
        expect(resolved.args).not.toContain("bypassPermissions");
        expect(resolved.args).not.toContain("dontAsk");
      }
    }
  });
});

describe("writable roots", () => {
  const roots = ["/repo/.git", "/var/tmp/reports"];

  it.each([
    { provider: "codex" as const, prefix: ["-s", "workspace-write", "-a", "never"] },
    { provider: "claude" as const, prefix: ["--permission-mode", "auto"] },
    { provider: "cursor" as const, prefix: ["--sandbox", "enabled"] },
  ])("grants $provider each root with --add-dir", ({ provider, prefix }) => {
    const result = resolveProviderPermissionPlan(provider, {
      sandbox: "workspace-write",
      approvalMode: "auto",
      writableRoots: roots,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.args).toEqual([
      ...prefix,
      "--add-dir",
      "/repo/.git",
      "--add-dir",
      "/var/tmp/reports",
    ]);
  });

  it("refuses roots a read-only sandbox cannot grant rather than emitting them anyway", () => {
    const result = resolveProviderPermissionPlan("codex", {
      sandbox: "read-only",
      approvalMode: "auto",
      writableRoots: ["/repo/.git"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("WRITABLE_ROOTS_REQUIRE_WORKSPACE_WRITE");
    expect(result.message).toContain("/repo/.git");
  });
});

describe("MCP approval shortfalls", () => {
  it("uses Codex automatic review for an opted-in workspace-write orchestrator", () => {
    const result = resolveProviderPermissionPlan("codex", {
      sandbox: "workspace-write",
      approvalMode: "auto",
      mcpInjected: true,
      codexApproveForMe: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.args).toEqual(["--approve-for-me"]);
    expect(result.value.shortfalls).toEqual([]);
  });

  it("does not let the combined Codex preset widen a read-only request", () => {
    const result = resolveProviderPermissionPlan("codex", {
      sandbox: "read-only",
      approvalMode: "auto",
      codexApproveForMe: true,
      mcpInjected: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.args).toEqual(["-s", "read-only", "-a", "never"]);
    expect(result.value.achieved.writes).toBe("denied");
    expect(result.value.shortfalls.map((shortfall) => shortfall.code))
      .toEqual(["MCP_APPROVAL_PROMPTS_REMAIN"]);
  });

  it("warns that an automatic Codex session still stops at MCP approval prompts", () => {
    const result = resolveProviderPermissionPlan("codex", {
      sandbox: "workspace-write",
      approvalMode: "auto",
      mcpInjected: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shortfalls.map((shortfall) => shortfall.code))
      .toEqual(["MCP_APPROVAL_PROMPTS_REMAIN"]);
    expect(result.value.shortfalls[0]?.message).toContain("cyberdeck");
  });

  it("does not warn when Codex was never asked for automatic approval", () => {
    const result = resolveProviderPermissionPlan("codex", {
      sandbox: "workspace-write",
      approvalMode: "prompt",
      mcpInjected: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shortfalls).toEqual([]);
  });

  it("does not warn for providers whose automatic approval covers MCP tool calls", () => {
    for (const provider of ["claude", "cursor"] as const) {
      const result = resolveProviderPermissionPlan(provider, {
        sandbox: "workspace-write",
        approvalMode: "auto",
        mcpInjected: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.shortfalls).toEqual([]);
    }
  });
});

describe("providers that refuse rather than substitute", () => {
  it("refuses workspace-write for Antigravity", () => {
    const result = resolveProviderPermissionPlan("antigravity", { sandbox: "workspace-write" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROVIDER_SANDBOX_UNSUPPORTED");
  });

  it("refuses automatic approval for Antigravity instead of quietly prompting", () => {
    const result = resolveProviderPermissionPlan("antigravity", {
      sandbox: "read-only",
      approvalMode: "auto",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PROVIDER_APPROVAL_MODE_UNSUPPORTED");
  });

  it("uses Cursor's ask mode for a read-only Scout without changing the write boundary", () => {
    const result = resolveProviderPermissionPlan("cursor", {
      sandbox: "read-only",
      cursorReadOnlyMode: "ask",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.args).toEqual(["--sandbox", "enabled", "--mode", "ask"]);
    expect(result.value.achieved.writes).toBe("denied");
  });
});
