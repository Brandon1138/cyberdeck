import {
  CavemanWorkersRequestSchema,
  EnsureOrchestratorRequestSchema,
  FableWorkersRequestSchema,
  orchestratorKey,
  type CavemanWorkersRequest,
  type CavemanWorkersResult,
  type EnsureOrchestratorRequest,
  type FableWorkersRequest,
  type FableWorkersResult,
  type OrchestratorBinding,
  type OrchestratorScope,
  type ResetOrchestratorRequest,
} from "../domain/orchestrator.js";
import type { SessionRecord } from "../domain/session.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";
import type { WorkerPreferenceStore } from "../persistence/worker-preference-store.js";
import type { SessionRegistry } from "../broker/session-registry.js";

export interface OrchestratorManagerResult {
  binding: OrchestratorBinding;
  session: SessionRecord;
  created: boolean;
}

export interface OrchestratorResetResult {
  key: string;
  reset: boolean;
  sessionId?: string;
}

export interface OrchestratorSessionResetResult {
  reset: boolean;
  key?: string;
}

export class OrchestratorManager {
  constructor(
    private readonly registry: SessionRegistry,
    private readonly store: OrchestratorStore,
    private readonly workerPreferences?: WorkerPreferenceStore,
  ) {}

  async ensure(input: EnsureOrchestratorRequest): Promise<OrchestratorManagerResult> {
    const request = EnsureOrchestratorRequestSchema.parse(input);
    const scope: OrchestratorScope = request.scope === "fleet"
      ? { kind: "fleet" }
      : { kind: "workspace", cwd: request.cwd };
    const key = orchestratorKey(scope);
    const existing = await this.store.get(key);
    if (existing !== undefined && request.provider === undefined) {
      const session = await this.resumeExisting(existing);
      if (session === undefined) {
        throw Object.assign(
          new Error("The configured orchestrator is not owned by this broker; choose its provider again"),
          { code: "ORCHESTRATOR_REBIND_REQUIRED" },
        );
      }
      return { binding: existing, session, created: false };
    }
    if (request.provider === undefined) {
      throw Object.assign(
        new Error("No orchestrator is configured for this scope; name an explicit provider"),
        { code: "ORCHESTRATOR_PROVIDER_REQUIRED" },
      );
    }
    if (
      existing !== undefined
      && existing.provider === request.provider
      && existing.model === request.model
      && existing.effort === request.effort
    ) {
      const session = await this.resumeExisting(existing);
      if (session !== undefined) return { binding: existing, session, created: false };
    } else if (existing !== undefined && this.isActive(existing.sessionId)) {
      throw Object.assign(
        new Error(
          `Orchestrator ${existing.sessionId} is active; stop it before rebinding this scope`,
        ),
        { code: "ORCHESTRATOR_ACTIVE_REBIND_REFUSED" },
      );
    }

    const session = await this.registry.start({
      provider: request.provider,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      cwd: request.cwd,
      detached: true,
      sandbox: "read-only",
      role: "orchestrator",
      kind: "orchestrator",
      orchestratorScope: request.scope,
      name: `Cyberdeck orchestrator (${request.provider}${request.model === undefined ? "" : `:${request.model}`})`,
      providerInstructions: orchestratorPrompt(scope),
    });
    const now = new Date().toISOString();
    const binding: OrchestratorBinding = {
      key,
      sessionId: session.id,
      provider: request.provider,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      cwd: request.cwd,
      sandbox: "read-only",
      scope,
      grant: {
        subjectSessionId: session.id,
        capabilities: ["thread.list", "thread.read", "thread.enqueue", "worker.start", "workflow.run"],
        scope,
      },
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.store.put(binding);
    } catch (error) {
      try {
        await this.registry.stop(session.id);
      } catch (cleanupError) {
        throw addCleanupContext(error, cleanupError, "stop newly created orchestrator after binding failure");
      }
      throw error;
    }
    return { binding, session, created: true };
  }

  async get(cwd: string, scopeKind: "workspace" | "fleet"): Promise<OrchestratorManagerResult | undefined> {
    const scope: OrchestratorScope = scopeKind === "fleet" ? { kind: "fleet" } : { kind: "workspace", cwd };
    const binding = await this.store.get(orchestratorKey(scope));
    if (binding === undefined) return undefined;
    const session = await this.resumeExisting(binding);
    return session === undefined ? undefined : { binding, session, created: false };
  }

  /** Operator-owned durable control over whether this binding may start Fable workers. */
  async fableWorkers(input: FableWorkersRequest): Promise<FableWorkersResult> {
    const request = FableWorkersRequestSchema.parse(input);
    const scope: OrchestratorScope = request.scope === "fleet"
      ? { kind: "fleet" }
      : { kind: "workspace", cwd: request.cwd };
    const key = orchestratorKey(scope);
    const binding = await this.store.get(key);
    if (binding === undefined) {
      if (request.enabled !== undefined) {
        throw Object.assign(
          new Error(`No orchestrator binding exists for ${key}; choose an orchestrator first`),
          { code: "ORCHESTRATOR_NOT_CONFIGURED" },
        );
      }
      return { key, configured: false, enabled: false };
    }

    const enabled = binding.grant.capabilities.includes("worker.start.fable");
    if (request.enabled === undefined || request.enabled === enabled) {
      return { key, configured: true, enabled, sessionId: binding.sessionId };
    }

    const capabilities = request.enabled
      ? [...binding.grant.capabilities, "worker.start.fable" as const]
      : binding.grant.capabilities.filter((capability) => capability !== "worker.start.fable");
    const updated: OrchestratorBinding = {
      ...binding,
      grant: { ...binding.grant, capabilities },
      updatedAt: new Date().toISOString(),
    };
    await this.store.put(updated);
    return {
      key,
      configured: true,
      enabled: request.enabled,
      sessionId: binding.sessionId,
    };
  }

  /** Operator-owned box default for Caveman communication in subsequently started workers. */
  async cavemanWorkers(input: CavemanWorkersRequest): Promise<CavemanWorkersResult> {
    const request = CavemanWorkersRequestSchema.parse(input);
    const preferences = this.requireWorkerPreferences();
    const current = await preferences.get();
    if (request.enabled === undefined || request.enabled === current.caveman) {
      return { scope: "box", enabled: current.caveman };
    }
    const updated = await preferences.set({ ...current, caveman: request.enabled });
    return { scope: "box", enabled: updated.caveman };
  }

  /** Resolve the current box default to snapshot into a newly started worker. */
  async workerMode(): Promise<"caveman" | "normal"> {
    return (await this.requireWorkerPreferences().get()).caveman ? "caveman" : "normal";
  }

  async reset(input: ResetOrchestratorRequest): Promise<OrchestratorResetResult> {
    const scope: OrchestratorScope = input.scope === "fleet"
      ? { kind: "fleet" }
      : { kind: "workspace", cwd: input.cwd };
    const key = orchestratorKey(scope);
    const binding = await this.store.get(key);
    if (binding === undefined) return { key, reset: false };
    if (this.isActive(binding.sessionId)) {
      throw Object.assign(
        new Error(
          `Orchestrator ${binding.sessionId} is active; run \`cyberdeck stop ${binding.sessionId}\` before resetting its binding`,
        ),
        { code: "ORCHESTRATOR_ACTIVE_RESET_REFUSED" },
      );
    }
    await this.store.reset(key);
    return { key, reset: true, sessionId: binding.sessionId };
  }

  /** Clear a binding as the final durable step before its terminal session record is deleted. */
  async resetSessionBinding(sessionId: string): Promise<OrchestratorSessionResetResult> {
    const binding = await this.store.findBySessionId(sessionId);
    if (binding === undefined) return { reset: false };
    await this.store.reset(binding.key);
    return { reset: true, key: binding.key };
  }

  private async resumeExisting(binding: OrchestratorBinding): Promise<SessionRecord | undefined> {
    try {
      const session = this.registry.get(binding.sessionId);
      if (session.executionState === "active" || session.executionState === "starting") return session;
      return await this.registry.resume(binding.sessionId);
    } catch (error) {
      if (isRecoverableResumeError(error)) return undefined;
      throw error;
    }
  }

  private isActive(sessionId: string): boolean {
    try {
      const session = this.registry.get(sessionId);
      return session.executionState === "active" || session.executionState === "starting";
    } catch {
      return false;
    }
  }

  private requireWorkerPreferences(): WorkerPreferenceStore {
    if (this.workerPreferences === undefined) {
      throw Object.assign(new Error("Worker preferences are not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.workerPreferences;
  }
}

function isRecoverableResumeError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "SESSION_NOT_FOUND" || error.code === "SESSION_RESUME_UNAVAILABLE";
}

function orchestratorPrompt(scope: OrchestratorScope): string {
  const description = scope.kind === "fleet" ? "the full Cyberdeck fleet" : `threads in ${scope.cwd}`;
  return [
    "You are the user's Cyberdeck orchestrator.",
    `Your authority is scoped to ${description}.`,
    "Use Cyberdeck's semantic tools to inspect changes, summarize workers, and enqueue complete instructions.",
    "Treat cyberdeck_provider_capabilities as authoritative for model IDs and effort support; never inspect repository source, config, or memory to discover Cyberdeck behavior.",
    "For fan-out, call cyberdeck_workers_start once. Then call cyberdeck_workers_wait once with successful sessionId and completionTarget values; do not poll and do not read raw transcripts for ordinary result collection.",
    "cyberdeck_thread_read is a bounded debugging escape hatch only. Always continue from its returned cursor and never reread from cursor zero.",
    "Never manipulate tmux panes or type through tmux send-keys.",
    "Do not stop, delete, or widen a worker's permissions without explicit human approval.",
  ].join(" ");
}

function addCleanupContext(primary: unknown, cleanup: unknown, action: string): Error {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup);
  return new Error(`${primaryError.message}; cleanup also failed to ${action}: ${cleanupMessage}`, {
    cause: primaryError,
  });
}
