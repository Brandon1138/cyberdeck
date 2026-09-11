import { readFileSync } from "node:fs";
import { ContainerNativeBindingSchema } from "../activity/container-native-source.js";
import { join } from "node:path";
import type { SessionRecord } from "../../domain/session.js";
import type { ProviderAdapter, ProviderLaunchSpec } from "../../orchestration/session/provider-ports.js";
import { ClaudeProviderAdapter } from "../../providers/claude.js";
import { CodexProviderAdapter } from "../../providers/codex.js";

/** Target-aware argument construction; host paths are never rewritten inside strings. */
export class ContainerProviderAdapter implements ProviderAdapter {
  readonly id: string;
  constructor(private readonly host: ProviderAdapter, private readonly root: string,
    private readonly codexWorkspaceIsolation: "native" | "container" = "native") { this.id = host.id; }
  private guest(session: SessionRecord): SessionRecord {
    if (session.workspace?.provisioning === "worker-provisioned" || (session.workspace?.writableRoots.length ?? 0) > 0) throw new Error("CONTAINER_WORKSPACE_POLICY_UNSUPPORTED");
    if (session.profile === "scout" || (session.imageAttachments?.length ?? 0) > 0) throw new Error("CONTAINER_PROVIDER_MODE_UNSUPPORTED");
    if (!["claude", "codex"].includes(this.id)) throw new Error("CONTAINER_PROVIDER_UNSUPPORTED");
    const { workspace: _workspace, ...rest } = session;
    return { ...rest, cwd: "/workspace" };
  }
  private adapter(session: SessionRecord, write = false, nativeSessionId?: string): ProviderAdapter {
    const mcp = { nodePath: "node", cliPath: "/opt/cyberdeck/mcp.mjs" };
    return this.id === "claude" ? new ClaudeProviderAdapter({ sourceEnvironment: {}, mcp, ...(nativeSessionId ? { nativeSessionId } : {}),
      directory: write ? join(this.root, "credentials", session.id, "launch") : "/run/credentials/launch",
      mcpAllowlist: { allowlistPath: join(this.root, "no-ambient-mcp.json"), operatorConfigPath: join(this.root, "no-ambient-provider-config.json") },
    }) : new CodexProviderAdapter({ sourceEnvironment: {}, mcp, ...(nativeSessionId ? { nativeSessionId } : {}),
      sessionsDirectory: join(this.root, "provider-state", session.id, ".codex", "sessions"),
    });
  }
  private nativeSessionId(session: SessionRecord): string {
    const binding = ContainerNativeBindingSchema.parse(JSON.parse(readFileSync(join(this.root, "native-bindings", `${session.id}.json`), "utf8")));
    if (binding.sessionId !== session.id || binding.provider !== session.provider) throw new Error("NATIVE_BINDING_CONFLICT");
    return binding.nativeSessionId;
  }
  private clean(spec: ProviderLaunchSpec): ProviderLaunchSpec {
    const keys = ["TERM", "DISABLE_UPDATES", "ENABLE_TOOL_SEARCH", "CYBERDECK_PROCESS_ROLE", "CYBERDECK_WORKER_MODE", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"];
    if (spec.executable === "claude") {
      if (spec.args[spec.args.indexOf("--permission-mode") + 1] === "auto") {
        // The writable container enforces filesystem/network scope. Approve only routine tools;
        // unknown tools, login and trust prompts retain their existing operator boundary.
        spec.args.unshift("--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,mcp__cyberdeck__cyberdeck_report_progress,mcp__cyberdeck__cyberdeck_signal_exception,mcp__cyberdeck__cyberdeck_signal_risk,mcp__cyberdeck__cyberdeck_request_decision,mcp__cyberdeck__cyberdeck_respond_checkpoint");
      }
      // Baked guest helper writes only provider-owned state. Host attribution validates the file.
      const end = spec.args.indexOf("--");
      spec.args.splice(end < 0 ? spec.args.length : end, 0, "--settings", JSON.stringify({ hooks: {
        SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: "node /opt/cyberdeck/native-binding.mjs" }] }],
      } }));
    } else if (spec.executable === "codex" && spec.args[spec.args.indexOf("-s") + 1] === "read-only") {
      // Read-only remains enforced by the native sandbox regardless of the writable opt-in.
      spec.args.unshift("--enable", "use_legacy_landlock");
    } else if (spec.executable === "codex" && this.codexWorkspaceIsolation === "container"
      && spec.args[spec.args.indexOf("-s") + 1] === "workspace-write") {
      // Explicit operator opt-in: OrbStack and the worker gateway enforce the boundary.
      // Routine permitted operations must not wait for interactive approval.
      spec.args[spec.args.indexOf("-s") + 1] = "danger-full-access";
      const approval = spec.args.indexOf("-a");
      if (approval < 0) throw new Error("CONTAINER_CODEX_APPROVAL_POLICY_MISSING");
      spec.args[approval + 1] = "never";
    }
    return { ...spec, env: Object.fromEntries(Object.entries(spec.env).filter(([key]) => keys.includes(key))) };
  }
  buildLaunchSpec(session: SessionRecord, prompt?: string): ProviderLaunchSpec {
    return session.executor !== "orbstack-container" ? this.host.buildLaunchSpec(session, prompt)
      : this.clean(this.adapter(session).buildLaunchSpec(this.guest(session), prompt));
  }
  buildResumeSpec(session: SessionRecord): ProviderLaunchSpec {
    return session.executor !== "orbstack-container" ? this.host.buildResumeSpec(session)
      : this.clean(this.adapter(session, false, this.nativeSessionId(session)).buildResumeSpec(this.guest(session)));
  }
  async prepareLaunch(session: SessionRecord, spec: ProviderLaunchSpec): Promise<void> {
    if (session.executor !== "orbstack-container") { await this.host.prepareLaunch?.(session, spec); return; }
    await this.adapter(session, true).prepareLaunch?.(this.guest(session), spec);
  }
  async cleanupLaunch(session: SessionRecord): Promise<void> {
    if (session.executor !== "orbstack-container") await this.host.cleanupLaunch?.(session);
    // Container launch/config files remain for recovery/collection; retirement owns their policy.
  }
  submitInput(message: string, session?: SessionRecord): Buffer {
    // Explicit paste framing prevents the guest TUI's burst heuristic from swallowing Enter.
    const text = session?.executor === "orbstack-container" ? `\u001b[200~${message}\u001b[201~` : message;
    return this.host.submitInput?.(text) ?? Buffer.from(`${text}\n`);
  }
  deferInitialPrompt(session: SessionRecord): boolean { return this.host.deferInitialPrompt?.(session) ?? false; }
  async initializeSession(session: SessionRecord, terminal: Parameters<NonNullable<ProviderAdapter["initializeSession"]>>[1]): Promise<void> {
    await this.host.initializeSession?.(session, terminal);
  }
  async submitInputToTerminal(message: string, terminal: Parameters<NonNullable<ProviderAdapter["submitInputToTerminal"]>>[1]): Promise<void> {
    if (this.host.submitInputToTerminal) await this.host.submitInputToTerminal(message, terminal);
    else terminal.write(this.submitInput(message));
  }
}
