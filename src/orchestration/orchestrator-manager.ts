import {
  CavemanWorkersRequestSchema,
  CreateOrchestratorRequestSchema,
  CreatePeerOrchestratorRequestSchema,
  EnsureOrchestratorRequestSchema,
  FableWorkersRequestSchema,
  ORCHESTRATOR_GRANT_CAPABILITIES,
  PeerCreateRequestSchema,
  orchestratorKey,
  peerOrchestratorKey,
  type CavemanWorkersRequest,
  type CavemanWorkersResult,
  type CreateOrchestratorRequest,
  type CreatePeerOrchestratorRequest,
  type EnsureOrchestratorRequest,
  type FableWorkersRequest,
  type FableWorkersResult,
  type PeerCreateRequest,
  type PeerCreateResult,
  type OrchestratorBinding,
  type OrchestratorGrantToggleRequest,
  type OrchestratorGrantToggleResult,
  type OrchestratorScope,
  type ResetOrchestratorRequest,
} from "../domain/orchestrator.js";
import type { CyberdeckCapability } from "../domain/capability.js";
import type { ApprovalMode, ProviderId, Sandbox, SessionRecord } from "../domain/session.js";
import { resolveProviderPermission } from "./permission-policy.js";
import type {
  OrchestratorBindingRepository,
  ProviderPermissionPreferenceReader,
  WorkerPreferenceRepository,
} from "./persistence-ports.js";
import { resolveProviderPermissionPlan } from "../domain/permission-resolution.js";
import { ORCHESTRATOR_CATALOG, orchestratorCatalog, orchestratorModelEfforts, type OrchestratorCatalogEntry } from "./orchestrator-catalog.js";
import { fallbackWorkerCapabilities, type ResolvedWorkerCapability } from "./worker-capabilities.js";
import { orchestratorPrompt } from "./orchestrator-prompt.js";
import type {
  SessionLookupPort,
  SessionResumePort,
  SessionStartPort,
} from "./session/session-ports.js";

export interface OrchestratorManagerResult {
  binding: OrchestratorBinding;
  session: SessionRecord;
  created: boolean;
  /**
   * Capabilities the resolved permission mode could not deliver. An orchestrator session hardcodes
   * Claude orchestrators remain read-only, so automatic mode asks for something Claude has no
   * write-denying mode to express without prompting. Codex orchestrators use its reviewed
   * workspace-write preset. Any diminished request starts and says so.
   */
  warnings?: string[];
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

type BoundOrchestratorRequest = EnsureOrchestratorRequest & {
  provider: CreateOrchestratorRequest["provider"];
};

/** What a peer made by an orchestrator carries beyond Fleet's own `create`: lineage and a bounded grant. */
interface PeerOrigin {
  createdBy: { sessionId: string };
  capabilities: readonly CyberdeckCapability[];
  name?: string;
}

export class OrchestratorManager {
  constructor(
    private readonly registry: SessionLookupPort & SessionStartPort & SessionResumePort,
    private readonly store: OrchestratorBindingRepository,
    private readonly workerPreferences?: WorkerPreferenceRepository,
    private readonly providerPermissions?: ProviderPermissionPreferenceReader,
    private readonly readCapabilities?: (provider: ProviderId) => Promise<ResolvedWorkerCapability[]>,
    private readonly observeBindingSession?: (binding: OrchestratorBinding, session?: SessionRecord) => Promise<void>,
  ) {}

  async ensure(input: EnsureOrchestratorRequest): Promise<OrchestratorManagerResult> {
    const request = EnsureOrchestratorRequestSchema.parse(input);
    const scope: OrchestratorScope = request.scope === "fleet"
      ? { kind: "fleet" }
      : { kind: "workspace", cwd: request.cwd };
    const key = orchestratorKey(scope);
    const existing = await this.store.get(key);
    const effectiveProvider = request.provider ?? existing?.provider;
    if (effectiveProvider !== undefined) assertMcpCapableProvider(effectiveProvider);
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

    return this.createBound(request as BoundOrchestratorRequest, scope, false, existing);
  }

  /** Always creates a distinct bound peer; it never consults or replaces the scope's primary binding. */
  async create(input: CreateOrchestratorRequest): Promise<OrchestratorManagerResult> {
    const request = CreateOrchestratorRequestSchema.parse(input);
    return this.createValidatedPeer(request);
  }

  /**
   * A peer another orchestrator asked for. Same validation and launch as Fleet's `create`; the
   * differences are the binding's lineage and a grant the caller derived (`peerGrantCapabilities`)
   * instead of the full default list. Policy — who may ask, for what scope, how many — is the
   * peer service's; this only records what it decided.
   */
  async createPeer(input: CreatePeerOrchestratorRequest): Promise<OrchestratorManagerResult> {
    const { createdBy, capabilities, name, ...request } = CreatePeerOrchestratorRequestSchema.parse(input);
    return this.createValidatedPeer(request, {
      createdBy,
      capabilities,
      ...(name === undefined ? {} : { name }),
    });
  }

  private async createValidatedPeer(
    request: CreateOrchestratorRequest,
    origin?: PeerOrigin,
  ): Promise<OrchestratorManagerResult> {
    const capabilities = request.provider === "codex" ? await this.capabilities() : undefined;
    validateCreateSelection(request, orchestratorCatalog(capabilities));
    const scope: OrchestratorScope = request.scope === "fleet"
      ? { kind: "fleet" }
      : { kind: "workspace", cwd: request.cwd };
    return this.createBound(request, scope, true, undefined, origin);
  }

  /** Fleet and creation validate against the same first-party Codex discovery context. */
  async capabilities(): Promise<ResolvedWorkerCapability[]> {
    return this.readCapabilities?.("codex")
      ?? fallbackWorkerCapabilities("Codex orchestrator discovery is unavailable", "codex");
  }

  /**
   * The grant is written *during* the start, not after it.
   *
   * A provider with no system-prompt flag — Cursor — receives `providerInstructions` as the
   * session's first message, and that turn runs inside `registry.start`. An orchestrator told what
   * it is will reach for Cyberdeck's tools immediately, so a binding persisted after `start`
   * returned would lose the race and the orchestrator's opening move would come back
   * `ACTOR_NOT_AUTHORIZED`. Persisting from the activation step closes the window for every
   * provider at once rather than special-casing the one that exposed it.
   *
   * `previous` is the binding this call is replacing, if any. A start that fails after the grant is
   * durable would otherwise strand a binding pointing at a session that never lived, so the prior
   * state is put back exactly as it was.
   */
  private async createBound(
    request: BoundOrchestratorRequest,
    scope: OrchestratorScope,
    peer: boolean,
    previous?: OrchestratorBinding,
    origin?: PeerOrigin,
  ): Promise<OrchestratorManagerResult> {
    const capabilities = origin?.capabilities ?? ORCHESTRATOR_GRANT_CAPABILITIES;
    const approvalMode = request.approvalMode
      ?? await this.configuredApprovalMode(request.provider);
    const sandbox = orchestratorSandbox(request.provider);
    // Resolved before the session exists so an unsatisfiable request is refused at create time,
    // and a satisfiable-but-diminished one is reported instead of discovered at a prompt.
    const plan = resolveProviderPermissionPlan(request.provider, {
      sandbox,
      approvalMode,
      mcpInjected: true,
      codexApproveForMe: request.provider === "codex",
    });
    if (!plan.ok) {
      throw Object.assign(new Error(plan.message), { code: plan.code });
    }
    const warnings = plan.value.shortfalls.map((shortfall) => shortfall.message);
    const primaryKey = orchestratorKey(scope);
    let binding: OrchestratorBinding | undefined;
    let session: SessionRecord;
    try {
      session = await this.registry.start({
        provider: request.provider,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        ...(approvalMode === undefined ? {} : { approvalMode }),
        cwd: request.cwd,
        detached: true,
        sandbox,
        role: "orchestrator",
        kind: "orchestrator",
        orchestratorScope: request.scope,
        name: origin?.name
          ?? `Cyberdeck orchestrator (${request.provider}${request.model === undefined ? "" : `:${request.model}`})`,
        providerInstructions: orchestratorPrompt(scope, capabilities),
      }, undefined, async (started) => {
        const now = new Date().toISOString();
        binding = {
          key: peer ? peerOrchestratorKey(primaryKey, started.id) : primaryKey,
          kind: peer ? "peer" : "primary",
          sessionId: started.id,
          provider: request.provider,
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
          cwd: request.cwd,
          sandbox,
          scope,
          grant: {
            subjectSessionId: started.id,
            capabilities: [...capabilities],
            scope,
          },
          ...(origin === undefined ? {} : { createdBy: origin.createdBy }),
          createdAt: now,
          updatedAt: now,
        };
        await this.store.put(binding);
        await this.observeBindingSession?.(binding, started);
      });
    } catch (error) {
      if (binding !== undefined) {
        try { await this.observeBindingSession?.(binding); }
        finally { await this.restoreBinding(binding.key, previous, error); }
      }
      throw error;
    }
    if (binding === undefined) {
      throw new Error(`Orchestrator session ${session.id} started without persisting its binding`);
    }
    return {
      binding,
      session,
      created: true,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }

  /** Undo a binding written during a start that then failed, back to whatever preceded it. */
  private async restoreBinding(
    key: string,
    previous: OrchestratorBinding | undefined,
    cause: unknown,
  ): Promise<void> {
    try {
      if (previous === undefined) await this.store.reset(key);
      else await this.store.put(previous);
    } catch (cleanupError) {
      throw addCleanupContext(cause, cleanupError, `restore the orchestrator binding for ${key}`);
    }
  }

  private async configuredApprovalMode(provider: ProviderId): Promise<ApprovalMode | undefined> {
    const policy = (await this.providerPermissions?.list())?.[provider];
    if (policy === undefined) return undefined;
    const resolution = resolveProviderPermission(provider, policy, "read-only");
    if (!resolution.ok) {
      throw Object.assign(new Error(resolution.message), {
        code: "APPROVAL_MODE_NOT_SUPPORTED",
      });
    }
    return resolution.value.application.kind === "post-launch-command"
      ? "auto"
      : resolution.value.application.value;
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
    return this.toggleGrantCapability(
      "worker.start.fable",
      FableWorkersRequestSchema.parse(input),
    );
  }

  /** Whether the scope's primary may create peer orchestrators; on by default for new bindings. */
  async peerCreate(input: PeerCreateRequest): Promise<PeerCreateResult> {
    return this.toggleGrantCapability(
      "orchestrator.create",
      PeerCreateRequestSchema.parse(input),
    );
  }

  /**
   * Read or rewrite one delegation capability on the scope's primary binding.
   *
   * The grant is the durable record, so a toggle survives broker restarts and applies to the exact
   * scope the operator named. Every per-capability command shares this path so a new grant cannot
   * acquire subtly different scope, persistence, or unconfigured-binding behavior.
   */
  private async toggleGrantCapability(
    capability: Extract<CyberdeckCapability, `worker.start.${string}` | "orchestrator.create">,
    request: OrchestratorGrantToggleRequest,
  ): Promise<OrchestratorGrantToggleResult> {
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

    const enabled = binding.grant.capabilities.includes(capability);
    if (request.enabled === undefined || request.enabled === enabled) {
      return { key, configured: true, enabled, sessionId: binding.sessionId };
    }

    const capabilities = request.enabled
      ? [...binding.grant.capabilities, capability]
      : binding.grant.capabilities.filter((entry) => entry !== capability);
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

  /**
   * Operator-owned box default for Caveman communication in subsequently started *orchestrator*
   * workers. Composer-launched workers (Fleet's manual `session.start`/`session.startWithPrompt`)
   * never read this default; they are always eloquent (MIK-79).
   */
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
    assertMcpCapableProvider(binding.provider);
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

  private requireWorkerPreferences(): WorkerPreferenceRepository {
    if (this.workerPreferences === undefined) {
      throw Object.assign(new Error("Worker preferences are not available"), { code: "METHOD_NOT_FOUND" });
    }
    return this.workerPreferences;
  }
}

function orchestratorSandbox(provider: ProviderId): Sandbox {
  return provider === "codex" ? "workspace-write" : "read-only";
}

/** Single source of truth for which providers can host the Cyberdeck MCP server. */
function supportsMcpOrchestration(provider: ProviderId): boolean {
  return ORCHESTRATOR_CATALOG.some((entry) => entry.provider === provider);
}

/** Refuse inert orchestrators before any registry get, resume, or start. */
function assertMcpCapableProvider(provider: ProviderId): void {
  if (supportsMcpOrchestration(provider)) return;
  throw Object.assign(
    new Error(
      `Orchestrator provider ${provider} cannot receive the Cyberdeck MCP server; its adapter has no supported MCP surface`,
    ),
    { code: "ORCHESTRATOR_PROVIDER_UNSUPPORTED" },
  );
}

function isRecoverableResumeError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "SESSION_NOT_FOUND" || error.code === "SESSION_RESUME_UNAVAILABLE";
}

function validateCreateSelection(request: CreateOrchestratorRequest, catalog: readonly OrchestratorCatalogEntry[]): void {
  const provider = catalog.find((entry) => entry.provider === request.provider);
  if (provider === undefined || !provider.models.includes(request.model)) {
    throw Object.assign(
      new Error(`Unsupported orchestrator selection: ${request.provider}:${request.model}`),
      { code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" },
    );
  }
  const effort = request.effort ?? "native-default";
  if (!orchestratorModelEfforts(provider, request.model).includes(effort)) {
    throw Object.assign(
      new Error(`${request.provider}:${request.model} does not support ${effort} effort`),
      { code: "ORCHESTRATOR_SELECTION_UNSUPPORTED" },
    );
  }
}

function addCleanupContext(primary: unknown, cleanup: unknown, action: string): Error {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup);
  return new Error(`${primaryError.message}; cleanup also failed to ${action}: ${cleanupMessage}`, {
    cause: primaryError,
  });
}
