import type { SessionRecord } from "../domain/session.js";
import { evaluateClaudeLaunchSafety } from "../domain/policy.js";
import { ClaudeLaunchSafetyError } from "./claude/headless-command.js";
import { claudePermissionMode } from "./claude/permissions.js";
import type { CyberdeckMcpLaunch, ProviderAdapter, ProviderLaunchSpec } from "./provider.js";
import { sessionLaunchEnvironment } from "./launch-environment.js";

/**
 * Claude's durable interactive (PTY) launch. The bounded/headless path lives in
 * `./claude/dispatch-adapter.js`; interactive versus headless is an execution dimension of one
 * provider, not two providers.
 */
export class ClaudeProviderAdapter implements ProviderAdapter {
  readonly id = "claude" as const;

  constructor(private readonly options: { mcp?: CyberdeckMcpLaunch } = {}) {}

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
    // Forwarded only because the caller explicitly supplied it; Cyberdeck never chooses a model.
    if (session.model !== undefined) {
      args.push("--model", session.model);
    }
    if (session.effort !== undefined) {
      if (session.effort === "ultra") throw new Error("Claude does not support ultra effort");
      args.push("--effort", session.effort);
    }
    this.addProviderInstructions(args, session);
    this.addOrchestratorIsolation(args, session);
    this.addCyberdeckMcp(args, session);
    if (initialPrompt !== undefined) {
      args.push("--", initialPrompt);
    }

    return {
      executable: "claude",
      args,
      cwd: session.cwd,
      env: sessionLaunchEnvironment({ ...process.env, DISABLE_UPDATES: "1" }, session),
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
    if (session.model !== undefined) args.push("--model", session.model);
    if (session.effort !== undefined) {
      if (session.effort === "ultra") throw new Error("Claude does not support ultra effort");
      args.push("--effort", session.effort);
    }
    this.addProviderInstructions(args, session);
    this.addOrchestratorIsolation(args, session);
    this.addCyberdeckMcp(args, session);
    return {
      executable: "claude",
      args,
      cwd: session.cwd,
      env: sessionLaunchEnvironment({ ...process.env, DISABLE_UPDATES: "1" }, session),
    };
  }

  private addProviderInstructions(args: string[], session: SessionRecord): void {
    if (session.providerInstructions === undefined) return;
    args.push("--append-system-prompt", session.providerInstructions);
  }

  /**
   * An orchestrator's authority is Cyberdeck's own tools, so it launches against a bounded context
   * rather than whatever the operator happens to have installed. Measured on a fleet orchestrator:
   * the ambient skill and plugin surface put ~86k tokens into the prompt before the first turn and
   * ~150k after each compaction, which left two or three usable turns and made autocompaction
   * thrash. Both flags are orchestrator-only; workers keep the operator's environment, and dropping
   * user settings here is safe because Cyberdeck's own session-start hook is worker-scoped.
   */
  private addOrchestratorIsolation(args: string[], session: SessionRecord): void {
    if (session.kind !== "orchestrator") return;
    args.push("--disable-slash-commands");
    args.push("--setting-sources", "project,local");
  }

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
  }
}
