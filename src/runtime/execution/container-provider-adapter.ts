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
  constructor(private readonly host: ProviderAdapter, private readonly root: string) { this.id = host.id; }
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
      // Baked guest helper writes only provider-owned state. Host attribution validates the file.
      const end = spec.args.indexOf("--");
      spec.args.splice(end < 0 ? spec.args.length : end, 0, "--settings", JSON.stringify({ hooks: {
        SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: "node /opt/cyberdeck/native-binding.mjs" }] }],
      } }));
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
  submitInput(message: string): Buffer { return this.host.submitInput?.(message) ?? Buffer.from(`${message}\n`); }
  deferInitialPrompt(session: SessionRecord): boolean { return this.host.deferInitialPrompt?.(session) ?? false; }
  async initializeSession(session: SessionRecord, terminal: Parameters<NonNullable<ProviderAdapter["initializeSession"]>>[1]): Promise<void> {
    await this.host.initializeSession?.(session, terminal);
  }
  async submitInputToTerminal(message: string, terminal: Parameters<NonNullable<ProviderAdapter["submitInputToTerminal"]>>[1]): Promise<void> {
    if (this.host.submitInputToTerminal) await this.host.submitInputToTerminal(message, terminal);
    else terminal.write(this.submitInput(message));
  }
}
