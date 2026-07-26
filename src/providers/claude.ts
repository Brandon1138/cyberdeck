import type { SessionRecord } from "../domain/session.js";
import { evaluateClaudeLaunchSafety } from "../domain/policy.js";
import { ClaudeLaunchSafetyError } from "./claude/headless-command.js";
import { claudePermissionMode } from "./claude/permissions.js";
import type { CyberdeckMcpLaunch, ProviderAdapter, ProviderLaunchSpec } from "./provider.js";
import { sessionLaunchEnvironment } from "./launch-environment.js";
import {
  resolveOrchestratorMcpServers,
  type OrchestratorMcpPaths,
} from "./claude/orchestrator-mcp-servers.js";
import {
  removeSessionLaunchFiles,
  sessionLaunchFilePath,
  writeSessionLaunchFile,
  type SessionLaunchFilesOptions,
} from "./session-launch-files.js";
import { UnsupportedProviderEffortError } from "./session-adapter-errors.js";
import {
  addClaudeNoSubagentArgs,
  CLAUDE_ORCHESTRATOR_TOOL_DENIALS,
  CLAUDE_NO_SUBAGENT_ENV,
} from "./claude/no-subagents.js";

export interface ClaudeProviderAdapterOptions extends SessionLaunchFilesOptions {
  mcp?: CyberdeckMcpLaunch;
  sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
  /** Overrides the operator state `resolveOrchestratorMcpServers` reads; for tests. */
  orchestratorMcp?: OrchestratorMcpPaths;
}

/**
 * Claude's durable interactive (PTY) launch. The bounded/headless path lives in
 * `./claude/dispatch-adapter.js`; interactive versus headless is an execution dimension of one
 * provider, not two providers.
 */
export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly id = "claude" as const;

  constructor(private readonly options: ClaudeProviderAdapterOptions = {}) {}

  submitInput(message: string): Buffer {
    // Claude enables Kitty keyboard disambiguation in its PTY (`CSI > 1 u`). A legacy carriage
    // return is then only text-editing input; synthesize the negotiated Enter key to submit.
    return Buffer.from(`${message}\u001b[13u`);
  }

  buildLaunchSpec(session: SessionRecord, initialPrompt?: string): ProviderLaunchSpec {
    // The session registry evaluates this call as the argument to its pty factory, so throwing here
    // fails the launch before any process is constructed. An omitted model is unsafe rather than
    // implicitly operator-selected: the recorded native default displayed Fable.
    const safety = evaluateClaudeLaunchSafety(this.id, session.model);
    if (!safety.safe) {
      throw new ClaudeLaunchSafetyError(safety.code);
    }

    const args = [
      "--session-id",
      session.id,
      "--name",
      session.name ?? session.id,
      "--permission-mode",
      claudePermissionMode(session.sandbox, session.approvalMode),
    ];
    addClaudeNoSubagentArgs(
      args,
      session.kind === "orchestrator" ? CLAUDE_ORCHESTRATOR_TOOL_DENIALS : [],
    );
    // Forwarded only because the caller explicitly supplied it; Cyberdeck never chooses a model.
    if (session.model !== undefined) {
      args.push("--model", session.model);
    }
    if (session.effort !== undefined) {
      if (session.effort === "ultra") throw new UnsupportedProviderEffortError(this.id);
      args.push("--effort", session.effort);
    }
    this.addProviderInstructions(args, session);
    this.addOrchestratorIsolation(args, session);
    this.addCyberdeckMcp(args, session);
    this.useMcpConfigFile(args, session);
    if (initialPrompt !== undefined) {
      args.push("--", initialPrompt);
    }

    return {
      executable: "claude",
      args,
      cwd: session.cwd,
      env: this.launchEnvironment(session),
    };
  }

  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec {
    const safety = evaluateClaudeLaunchSafety(this.id, session.model);
    if (!safety.safe) throw new ClaudeLaunchSafetyError(safety.code);

    const args = [
      "--resume",
      session.id,
      "--name",
      session.name ?? session.id,
      "--permission-mode",
      claudePermissionMode(session.sandbox, session.approvalMode),
    ];
    addClaudeNoSubagentArgs(
      args,
      session.kind === "orchestrator" ? CLAUDE_ORCHESTRATOR_TOOL_DENIALS : [],
    );
    if (session.model !== undefined) args.push("--model", session.model);
    if (session.effort !== undefined) {
      if (session.effort === "ultra") throw new UnsupportedProviderEffortError(this.id);
      args.push("--effort", session.effort);
    }
    this.addProviderInstructions(args, session);
    this.addOrchestratorIsolation(args, session);
    this.addCyberdeckMcp(args, session);
    this.useMcpConfigFile(args, session);
    return {
      executable: "claude",
      args,
      cwd: session.cwd,
      env: this.launchEnvironment(session),
    };
  }

  /**
   * `ENABLE_TOOL_SEARCH` defers tool schemas and loads them on demand. This was previously forced
   * to `false` on the finding that 2.1.220 built the deferred index without MCP tools, leaving
   * `mcp__cyberdeck__*` registered but unreachable. That finding does not reproduce: against
   * 2.1.220 a `^mcp__` search returns all twelve, and 2.1.220's own model-facing guidance states
   * MCP schemas are deferred by default and that their deferred cost must not be counted against
   * them. The override was also inert — sessions launched with `false` ran with tool search on
   * regardless, since only `true`, `auto`, and `auto:N` are honored values.
   *
   * Forced to `true` rather than deleted, because absent it is decided optimistically: disabled off
   * a non-first-party `ANTHROPIC_BASE_URL`. An operator behind a proxy would get every schema
   * resident, which is the outcome deferral exists to avoid and the one that actually costs a
   * fleet orchestrator its context. Cyberdeck injects the server, so it owns the guarantee that the
   * cheap path is the one taken.
   *
   * Applies to workers too, and matters more for them: they inherit the operator's whole ambient set
   * and are the sessions with the most schemas to defer. `addOrchestratorIsolation` does not cover
   * this — `--setting-sources` drops user *settings*, while this arrives through process inheritance
   * and lands in every launched session regardless of scope.
   */
  private launchEnvironment(session: SessionRecord): NodeJS.ProcessEnv {
    return {
      ...sessionLaunchEnvironment(
        this.options.sourceEnvironment ?? process.env,
        this.id,
        session.cwd,
        session,
        {
          disableUpdates: true,
          enableToolSearch: session.kind !== undefined && this.options.mcp !== undefined,
        },
      ),
      ...CLAUDE_NO_SUBAGENT_ENV,
    };
  }

  private addProviderInstructions(args: string[], session: SessionRecord): void {
    if (session.providerInstructions === undefined) return;
    args.push("--append-system-prompt-file", this.instructionsPath(session));
  }

  async prepareLaunch(session: SessionRecord, _spec: ProviderLaunchSpec): Promise<void> {
    const writes: Promise<unknown>[] = [];
    if (session.providerInstructions !== undefined) {
      writes.push(writeSessionLaunchFile(
        session.id,
        "provider-instructions.txt",
        session.providerInstructions,
        this.options,
      ));
    }
    if (session.kind !== undefined && this.options.mcp !== undefined) {
      // Workers already inherit the operator's servers, so the allowlist only has work to do for an
      // orchestrator, whose config is exclusive. Cyberdeck is spread last: an allowlist entry named
      // `cyberdeck` must never displace the control plane the orchestrator's authority rests on.
      const allowlisted = session.kind === "orchestrator"
        ? await resolveOrchestratorMcpServers(this.options.orchestratorMcp ?? {})
        : {};
      writes.push(writeSessionLaunchFile(
        session.id,
        "mcp-config.json",
        JSON.stringify({
          mcpServers: {
            ...allowlisted,
            cyberdeck: {
              type: "stdio",
              command: this.options.mcp.nodePath,
              args: [this.options.mcp.cliPath, "mcp", "--actor-session", session.id],
            },
          },
        }),
        this.options,
      ));
    }
    await Promise.all(writes);
  }

  async cleanupLaunch(session: SessionRecord): Promise<void> {
    await removeSessionLaunchFiles(session.id, this.options);
  }

  /**
   * An orchestrator's authority is Cyberdeck's own tools, so it launches against a bounded context
   * rather than whatever the operator happens to have installed. `--setting-sources project,local`
   * drops user scope, which is where the operator's skills, plugins and ambient MCP servers live —
   * the whole surface that once put ~86k tokens into a fleet orchestrator's prompt before its first
   * turn. It is orchestrator-only: workers keep the operator's environment, and dropping user
   * settings here is safe because Cyberdeck's own session-start hook is worker-scoped.
   * `--strict-mcp-config` is the MCP half of the same bound and is emitted next to the config it
   * constrains, in `addCyberdeckMcp`.
   *
   * This deliberately does *not* pass `--disable-slash-commands`. `claude --help` describes that
   * flag as "Disable all skills", but measured against Claude Code 2.1.220 it empties the entire
   * command registry: the `init` event reports `slash_commands: []` and drops the `Skill` tool, so
   * built-ins go too and `/mcp` renders `No commands match "/mcp"`. `/mcp` is the only way to finish
   * a connector's OAuth flow, and `/context` and `/compact` are the operator's only manual levers
   * over the pressure this bound exists to manage, so an orchestrator cockpit without them is not
   * usable. Measured here (2.1.220, `-p`, prompt tokens for one trivial turn): ambient 13,003;
   * `--setting-sources project,local` 7,703; adding `--disable-slash-commands` 5,837. User scope is
   * worth 5,300 tokens and this code still excludes it; the flag's remaining 1,866 tokens are the
   * built-in command surface itself, under 1% of a 200k window, and are the operator's cockpit.
   */
  private addOrchestratorIsolation(args: string[], session: SessionRecord): void {
    if (session.kind !== "orchestrator") return;
    args.push("--setting-sources", "project,local");
  }

  /**
   * `--mcp-config` *adds* to whatever MCP servers the operator has configured in `~/.claude.json`
   * rather than replacing them. `--strict-mcp-config` is what makes the injected config exclusive,
   * so an orchestrator's default tool surface is exactly Cyberdeck's own plus whatever the operator
   * allowlisted in `resolveOrchestratorMcpServers`.
   *
   * The original rationale was token cost — the operator's entire ambient set arriving unbidden,
   * Linear alone contributing roughly fifty tool definitions. That is not what deferral does with
   * them: schemas are held behind tool search and cost their names, not their definitions, until
   * something searches. Exclusivity is kept for a different and still-live reason — an orchestrator
   * should hold the authority the operator granted it, not everything that happens to be installed
   * on the machine — which is why reopening it is an explicit per-server allowlist and not a
   * dropped flag.
   *
   * It is orchestrator-only and deliberately paired with the `--mcp-config` it constrains. Workers
   * keep the operator's servers: a worker sent at a Linear or Obsidian task legitimately needs them.
   * Emitting the flag without a config would leave the process with no MCP servers at all, which is
   * a different outcome than the isolation intended here.
   */
  private addCyberdeckMcp(args: string[], session: SessionRecord): void {
    if (session.kind === undefined || this.options.mcp === undefined) return;
    args.push("--mcp-config", JSON.stringify({
      mcpServers: {
        cyberdeck: {
          type: "stdio",
          command: this.options.mcp.nodePath,
          args: [this.options.mcp.cliPath, "mcp", "--actor-session", session.id],
        },
      },
    }));
    if (session.kind === "orchestrator") args.push("--strict-mcp-config");
  }

  private useMcpConfigFile(args: string[], session: SessionRecord): void {
    if (session.kind === undefined || this.options.mcp === undefined) return;
    const configIndex = args.lastIndexOf("--mcp-config") + 1;
    args[configIndex] = this.mcpConfigPath(session);
  }

  private instructionsPath(session: SessionRecord): string {
    return sessionLaunchFilePath(session.id, "provider-instructions.txt", this.options);
  }

  private mcpConfigPath(session: SessionRecord): string {
    return sessionLaunchFilePath(session.id, "mcp-config.json", this.options);
  }
}
