import type { ApprovalMode, ProviderId, Sandbox } from "./session.js";

/**
 * What a stored permission request actually means, independent of any provider's vocabulary.
 *
 * The two dimensions are deliberately separate because the providers conflate them in opposite
 * directions. Codex names the write boundary (`-s`) and the prompt boundary (`-a`) with two flags
 * and applies both literally. Claude has one flag for both, so `--permission-mode auto` answers the
 * prompt question by widening the write question — which is exactly how the same stored request
 * became `-s read-only -a never` for a Codex worker and an unrestricted Claude worker.
 */
export interface EffectivePermission {
  /** Whether the session may modify files at all. */
  writes: "denied" | "workspace";
  /** Whether the session stops for a human approval before acting. */
  prompts: "interactive" | "never";
}

/**
 * The one place a `(sandbox, approvalMode)` pair becomes meaning. `approvalMode` is optional on the
 * wire and absent means `prompt`, which is why an unconfigured provider preference lands a worker
 * at an approval prompt rather than at automatic execution.
 */
export function resolveEffectivePermission(
  sandbox: Sandbox,
  approvalMode: ApprovalMode = "prompt",
): EffectivePermission {
  return {
    writes: sandbox === "workspace-write" ? "workspace" : "denied",
    prompts: approvalMode === "auto" ? "never" : "interactive",
  };
}

export function describeEffectivePermission(permission: EffectivePermission): string {
  const writes = permission.writes === "workspace" ? "may write its workspace" : "cannot write";
  const prompts = permission.prompts === "never" ? "never asks" : "asks before acting";
  return `${writes}, ${prompts}`;
}

/**
 * A requested capability the provider cannot deliver. Never silent: every shortfall is carried out
 * of resolution so worker start can refuse or warn with the provider's own reason.
 */
export interface PermissionShortfall {
  code: "APPROVAL_PROMPTS_REMAIN" | "MCP_APPROVAL_PROMPTS_REMAIN";
  message: string;
}

export type ProviderPostLaunchStep = "cursor-run-everything";

export interface ProviderPermissionPlan {
  provider: ProviderId;
  /** What the stored request asked for. */
  requested: EffectivePermission;
  /**
   * What the emitted flags actually deliver. `writes` always equals `requested.writes` — a provider
   * that cannot match the requested write boundary refuses instead of diverging. `prompts` may fall
   * back to `interactive`, and only ever in that direction, always with a matching shortfall.
   */
  achieved: EffectivePermission;
  /** Provider-native permission flags, in emission order. Contains nothing else. */
  args: readonly string[];
  /** Steps the adapter must run after launch for `achieved` to hold. */
  postLaunch: readonly ProviderPostLaunchStep[];
  shortfalls: readonly PermissionShortfall[];
}

export type PermissionResolutionFailureCode =
  | "PROVIDER_SANDBOX_UNSUPPORTED"
  | "PROVIDER_APPROVAL_MODE_UNSUPPORTED"
  | "WRITABLE_ROOTS_REQUIRE_WORKSPACE_WRITE";

export type ProviderPermissionPlanResult =
  | { ok: true; value: ProviderPermissionPlan }
  | { ok: false; code: PermissionResolutionFailureCode; message: string };

export interface ProviderPermissionRequest {
  sandbox: Sandbox;
  approvalMode?: ApprovalMode | undefined;
  /**
   * Absolute directories that must be writable alongside the workspace root. This is the mechanism
   * a worker needs to run `git worktree add`: the repository's git common directory lives outside
   * the worktree it is creating, and every provider blocks writes there without an explicit grant.
   */
  writableRoots?: readonly string[] | undefined;
  /** Whether the Cyberdeck MCP server is injected into this session. */
  mcpInjected?: boolean | undefined;
  /** Cursor's read-only mode differs between an interactive worker (`plan`) and a Scout (`ask`). */
  cursorReadOnlyMode?: "plan" | "ask" | undefined;
}

/** Claude's `--permission-mode` values Cyberdeck is willing to emit. `bypassPermissions` and
 * `dontAsk` are not among them and never will be. */
export const CLAUDE_PERMISSION_MODES = {
  "read-only": "plan",
  "workspace-write": { interactive: "manual", never: "auto" },
} as const;

const MCP_APPROVAL_AUTOMATIC: Record<ProviderId, boolean> = {
  // `-a never` governs shell execution. Codex 0.147.0 advertises no per-server or per-tool MCP
  // approval setting — `codex mcp add` has no such flag and the config schema has no such key — and
  // on 2026-08-14 automatic Codex workers were observed stopping at an interactive approval prompt
  // for a Cyberdeck MCP tool call. Unproven is treated as false.
  codex: false,
  // `--permission-mode auto` covers tool use, MCP tools included.
  claude: true,
  // The session-scoped `cli-config.json` allows exactly `Mcp(plugin-cyberdeck-cyberdeck:*)`, so MCP
  // approval is granted at launch rather than by the approval mode.
  cursor: true,
  // No MCP surface exists to approve.
  antigravity: true,
};

function addDirArgs(roots: readonly string[]): string[] {
  return roots.flatMap((root) => ["--add-dir", root]);
}

/**
 * Resolves one stored permission request into exactly one provider's launch behavior.
 *
 * This is the only place a sandbox or an approval mode becomes provider-native, so the four
 * adapters cannot drift into meaning different things by the same request. Callers must surface a
 * failure rather than substituting a nearby mode, and must surface `shortfalls` rather than letting
 * a worker discover them at a prompt nobody is watching.
 */
export function resolveProviderPermissionPlan(
  provider: ProviderId,
  request: ProviderPermissionRequest,
): ProviderPermissionPlanResult {
  const requested = resolveEffectivePermission(request.sandbox, request.approvalMode);
  const writableRoots = request.writableRoots ?? [];

  if (writableRoots.length > 0 && requested.writes === "denied") {
    return {
      ok: false,
      code: "WRITABLE_ROOTS_REQUIRE_WORKSPACE_WRITE",
      message:
        `Writable roots were requested for a read-only ${provider} session: `
        + `${writableRoots.join(", ")}. A read-only sandbox cannot grant them; ask for `
        + "sandbox workspace-write, or drop the roots.",
    };
  }

  if (provider === "antigravity") {
    if (requested.writes === "workspace") {
      return {
        ok: false,
        code: "PROVIDER_SANDBOX_UNSUPPORTED",
        message:
          "Antigravity does not support sandbox workspace-write; `agy` advertises accept-edits but "
          + "no committed evidence shows it preserves workspace-write without automatic approval",
      };
    }
    if (requested.prompts === "never") {
      return {
        ok: false,
        code: "PROVIDER_APPROVAL_MODE_UNSUPPORTED",
        message: "antigravity does not support Cyberdeck approval mode auto",
      };
    }
    return {
      ok: true,
      value: {
        provider,
        requested,
        achieved: requested,
        args: ["--mode", "plan", "--sandbox"],
        postLaunch: [],
        shortfalls: [],
      },
    };
  }

  const plan = provider === "codex"
    ? codexPlan(requested, writableRoots)
    : provider === "claude"
      ? claudePlan(requested, writableRoots)
      : cursorPlan(requested, writableRoots, request.cursorReadOnlyMode ?? "plan");

  const shortfalls = [...plan.shortfalls];
  if (
    request.mcpInjected === true
    && requested.prompts === "never"
    && !MCP_APPROVAL_AUTOMATIC[provider]
  ) {
    shortfalls.push({
      code: "MCP_APPROVAL_PROMPTS_REMAIN",
      message:
        `${provider} applies automatic approval to shell execution but not to Cyberdeck MCP tool `
        + "calls, so a session that reports over MCP will still stop at an interactive approval "
        + "prompt. Instruct it to report through the `cyberdeck` CLI instead.",
    });
  }
  return { ok: true, value: { ...plan, shortfalls } };
}

function codexPlan(
  requested: EffectivePermission,
  writableRoots: readonly string[],
): ProviderPermissionPlan {
  // Codex names both dimensions natively and applies both literally, so it is the one provider
  // whose flags are a direct transcription of the request.
  return {
    provider: "codex",
    requested,
    achieved: requested,
    args: [
      "-s",
      requested.writes === "workspace" ? "workspace-write" : "read-only",
      "-a",
      requested.prompts === "never" ? "never" : "on-request",
      ...addDirArgs(writableRoots),
    ],
    postLaunch: [],
    shortfalls: [],
  };
}

function claudePlan(
  requested: EffectivePermission,
  writableRoots: readonly string[],
): ProviderPermissionPlan {
  if (requested.writes === "denied") {
    // `plan` is Claude's only mode that denies writes. It is therefore what a read-only request
    // resolves to whatever the approval mode says: `auto` would answer the approval question by
    // granting writes the request explicitly refused.
    return {
      provider: "claude",
      requested,
      achieved: { writes: "denied", prompts: "interactive" },
      args: ["--permission-mode", CLAUDE_PERMISSION_MODES["read-only"]],
      postLaunch: [],
      shortfalls: requested.prompts === "never"
        ? [{
            code: "APPROVAL_PROMPTS_REMAIN",
            message:
              "Claude's only write-denying permission mode is `plan`, which still asks before "
              + "leaving it. Automatic approval cannot be honored without widening the read-only "
              + "sandbox this request asked for.",
          }]
        : [],
    };
  }
  return {
    provider: "claude",
    requested,
    achieved: requested,
    args: [
      "--permission-mode",
      CLAUDE_PERMISSION_MODES["workspace-write"][requested.prompts],
      ...addDirArgs(writableRoots),
    ],
    postLaunch: [],
    shortfalls: [],
  };
}

function cursorPlan(
  requested: EffectivePermission,
  writableRoots: readonly string[],
  readOnlyMode: "plan" | "ask",
): ProviderPermissionPlan {
  if (requested.writes === "denied") {
    // `/run-everything` is not scoped to the write boundary, so running it inside a read-only
    // session would silently widen the request the same way Claude's `auto` did. It is withheld and
    // the remaining prompts are declared instead.
    return {
      provider: "cursor",
      requested,
      achieved: { writes: "denied", prompts: "interactive" },
      args: ["--sandbox", "enabled", "--mode", readOnlyMode],
      postLaunch: [],
      shortfalls: requested.prompts === "never"
        ? [{
            code: "APPROVAL_PROMPTS_REMAIN",
            message:
              "Cursor grants automatic approval with `/run-everything`, which is not bounded by the "
              + "read-only mode. It is withheld so a read-only request is not widened; the session "
              + "keeps asking.",
          }]
        : [],
    };
  }
  // Cursor advertises only plan and ask as read-only modes, so workspace-write omits `--mode` and
  // relies on the normal agent mode with the sandbox still explicit.
  return {
    provider: "cursor",
    requested,
    achieved: requested,
    args: ["--sandbox", "enabled", ...addDirArgs(writableRoots)],
    postLaunch: requested.prompts === "never" ? ["cursor-run-everything"] : [],
    shortfalls: [],
  };
}
