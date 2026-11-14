import type { LaunchAdmission, LaunchReservation, LaunchOutcome } from "./session-ports.js";
import { resolveWorkerExecution } from "../../domain/worker-execution.js";
import { randomUUID } from "node:crypto";
import { evaluateStart } from "../../domain/policy.js";
import { imageInputRefusal, providerAttachesImagesAtLaunch } from "../../domain/image-input.js";
import type { SessionRuntime } from "../../domain/session-runtime.js";
import {
  StartSessionRequestSchema,
  type SessionRecord,
  type StartSessionRequest,
} from "../../domain/session.js";
import type { ProvisionedWorktree } from "../../domain/worker-workspace.js";
import {
  resolveScoutEffectiveState,
  type ScoutRuntimeState,
} from "../../domain/worker-profile.js";
import { resolvedLaunchRecord } from "./launch-record.js";
import type {
  ProviderAdapter,
  ProviderLaunchSpec,
  ProviderSessionTerminal,
} from "./provider-ports.js";
import type { ScoutSessionSupervisorFactory } from "./scout-session-supervisor.js";
import { SessionCatalog } from "./session-catalog.js";
import { cloneRecord, registryError, scoutLaunchError } from "./session-record-projection.js";
import { RegistryError } from "./session-registry-ports.js";
import { SessionRuntimeAssembly } from "./session-runtime-assembly.js";
import { SessionRuntimeObserver } from "./session-runtime-observer.js";
import { SessionWorkspaceCoordinator } from "./session-workspace-coordinator.js";
import { applyWorkerMode } from "./worker-mode.js";
import { addWorkerReportingGuidance } from "./worker-reporting.js";

export interface SessionLaunchCoordinatorOptions {
  catalog: SessionCatalog;
  workspace: SessionWorkspaceCoordinator;
  scoutSupervision: ScoutSessionSupervisorFactory;
  assembly: SessionRuntimeAssembly;
  observer: SessionRuntimeObserver;
  onLaunchOutcome: (sessionId: string) => void;
}

/**
 * Admission, isolation, spawn, and first turn — the one ordered path from a request to a session.
 *
 * The order is the contract. Policy admits the start before a worktree is provisioned, because a
 * worktree made for a start the concurrency budget was about to refuse is litter nobody asked for;
 * provisioning happens before any provider process exists, because a worker that has already
 * launched cannot be moved into one; and every failure between them unwinds exactly what it got to.
 */
export class SessionLaunchCoordinator {
  private readonly catalog: SessionCatalog;
  private readonly workspace: SessionWorkspaceCoordinator;
  private readonly scoutSupervision: ScoutSessionSupervisorFactory;
  private readonly assembly: SessionRuntimeAssembly;
  private readonly observer: SessionRuntimeObserver;
  private readonly onLaunchOutcome: (sessionId: string) => void;
  /** Starts admitted by policy but not yet represented in the catalog. */
  private pendingWorkerStarts = 0;
  private readonly claimedReservations = new Set<string>();

  private readonly outcomes = new Map<string, {
    transitionId: string; generation: number; phase: "preparing" | "uncertain" | "failed" | "ready";
    runtime?: SessionRuntime; error?: unknown;
  }>();

  launchOutcome(reservation: LaunchReservation, generation: number): LaunchOutcome {
    const evidence = this.outcomes.get(reservation.sessionId);
    if (!evidence || evidence.transitionId !== reservation.transitionId || evidence.generation !== generation) return { kind: "unresolved" };
    if (evidence.phase === "failed") return { kind: "failed", error: evidence.error ?? new Error("Launch terminated") };
    const runtime = this.catalog.sessions.get(reservation.sessionId);
    if (evidence.phase === "ready" && evidence.runtime && runtime?.sessionRuntime === evidence.runtime
      && !runtime.stopRequested && runtime.record.generation === generation
      && runtime.record.executionState === "active" && runtime.record.exitCode === null) {
      return { kind: "owned", session: cloneRecord(runtime.record) };
    }
    return { kind: "unresolved" };
  }

  constructor(options: SessionLaunchCoordinatorOptions) {
    this.catalog = options.catalog;
    this.workspace = options.workspace;
    this.scoutSupervision = options.scoutSupervision;
    this.assembly = options.assembly;
    this.observer = options.observer;
    this.onLaunchOutcome = options.onLaunchOutcome;
  }

  /**
   * `activate` is the caller's chance to make a record durable *before* the session can act on it.
   * A provider whose instructions have to be submitted as a message rather than a system prompt
   * takes its first model turn inside `initializeSession`, still within this call, so anything that
   * turn may read back through the broker — an orchestrator's grant above all — cannot be written
   * after `start` returns. A throwing `activate` tears the session down exactly as a failed
   * initialization does; it is never left live but unauthorized.
   */
  async start(
    request: StartSessionRequest,
    initialPrompt?: string,
    activate?: (record: SessionRecord) => Promise<void>,
    initialInstructionId?: string,
    admission?: LaunchAdmission,
    launchReservation?: LaunchReservation,
  ): Promise<SessionRecord> {
    let claimed = false;
    try {
      return await this.startAttempt(request, initialPrompt, activate, initialInstructionId, admission, launchReservation, () => { claimed = true; });
    } catch (error) {
      const evidence = launchReservation && this.outcomes.get(launchReservation.sessionId);
      if (claimed && evidence && evidence.transitionId === launchReservation!.transitionId) {
        evidence.error = error;
        if (evidence.phase === "preparing") evidence.phase = "failed";
      }
      throw error;
    }
  }

  private async startAttempt(
    request: StartSessionRequest, initialPrompt?: string, activate?: (record: SessionRecord) => Promise<void>,
    initialInstructionId?: string, admission?: LaunchAdmission, launchReservation?: LaunchReservation, claimed?: () => void,
  ): Promise<SessionRecord> {
    const validated = StartSessionRequestSchema.parse(request);
    if (launchReservation !== undefined) {
      if (validated.kind !== "orchestrator" || validated.provider !== "codex" || initialPrompt !== undefined
        || initialInstructionId !== undefined || admission === undefined || activate === undefined
        || this.catalog.options.store === undefined || this.catalog.options.residentLifecycle === undefined) {
        throw new Error("STRIGOI_RESERVATION_UNAUTHORIZED");
      }
      try {
        await this.catalog.options.residentLifecycle.validateReservation(launchReservation);
      } catch (error) {
        // This invocation was rejected before preparation. Do not overwrite evidence from
        // another invocation (or a recovered session) under the same reservation.
        if (!this.claimedReservations.has(launchReservation.sessionId) && !this.catalog.sessions.has(launchReservation.sessionId)) {
          this.outcomes.set(launchReservation.sessionId, { transitionId: launchReservation.transitionId, generation: 1, phase: "failed", error });
        }
        throw error;
      }
      if (this.claimedReservations.has(launchReservation.sessionId) || this.catalog.sessions.has(launchReservation.sessionId)) {
        throw new Error("STRIGOI_RESERVATION_ALREADY_CLAIMED");
      }
      this.claimedReservations.add(launchReservation.sessionId);
      this.outcomes.set(launchReservation.sessionId, { transitionId: launchReservation.transitionId, generation: 1, phase: "preparing" });
      claimed?.();
    }
    const execution = resolveWorkerExecution(validated, this.catalog.options.config.workerExecution);
    validated.executor = execution.executor;
    validated.executionProfile = execution.profile;
    // The launch boundary is the only place that knows whether an attachment list will actually
    // become launch arguments. A provider with no flag to carry them would drop the whole list
    // without a word, so the start is refused rather than run as a text-only prompt that looks
    // like it carried an image.
    if (
      validated.imageAttachments !== undefined
      && validated.imageAttachments.length > 0
      && !providerAttachesImagesAtLaunch(validated.provider)
    ) {
      throw new RegistryError(
        "PROVIDER_NO_IMAGE_INPUT",
        imageInputRefusal(validated.provider, validated.imageAttachments.length),
      );
    }
    try {
      await this.workspace.verifyStartRequest(validated);
    } catch (error) {
      throw registryError(error);
    }
    const parsed = validated;
    this.requireActiveParent(parsed.parentSessionId);
    const ancestry = this.catalog.resolveAncestry(parsed.parentSessionId);
    const decision = evaluateStart(parsed, ancestry, {
      activeWorkerCount: this.catalog.activeWorkerCount() + this.pendingWorkerStarts,
      maxConcurrentWorkers: this.catalog.options.config.maxConcurrentWorkers,
      maxDelegationDepth: this.catalog.options.config.maxDelegationDepth,
    });
    if (!decision.allowed) {
      const message = decision.code === "MAX_CONCURRENT_WORKERS"
        ? `Worker limit reached: ${decision.activeWorkers ?? 0} active / ${decision.maxConcurrentWorkers ?? "unknown"} allowed`
        : decision.code;
      throw new RegistryError(decision.code, message);
    }

    const reservesWorker = (parsed.kind ?? "worker") === "worker";
    if (reservesWorker) this.pendingWorkerStarts += 1;
    let reservationHeld = reservesWorker;
    const releaseReservation = () => {
      if (!reservationHeld) return;
      this.pendingWorkerStarts -= 1;
      reservationHeld = false;
    };

    const id = launchReservation?.sessionId ?? randomUUID();
    const now = new Date().toISOString();
    let scout: ScoutRuntimeState | undefined;
    try {
      scout = parsed.profile === "scout"
        ? await this.scoutSupervision.initialize(id, parsed.cwd)
        : undefined;
    } catch (error) {
      releaseReservation();
      throw registryError(error);
    }
    // Isolation is created here, after admission and before any provider process exists: a worktree
    // made for a start that the concurrency budget was about to refuse is litter nobody asked for,
    // and a worker that has already launched cannot be moved into one.
    let provisioned: ProvisionedWorktree | undefined;
    try {
      provisioned = await this.workspace.provision(parsed, id);
    } catch (error) {
      releaseReservation();
      throw registryError(error);
    }
    const provisional: SessionRecord = {
      ...parsed,
      ...(provisioned === undefined
        ? {}
        : { cwd: provisioned.workspace.worktreePath ?? parsed.cwd, workspace: provisioned.workspace }),
      kind: parsed.kind ?? "worker",
      id,
      generation: 1,
      createdAt: now,
      updatedAt: now,
      executionState: "starting",
      attachmentState: "detached",
      pid: 0,
      exitCode: null,
      childIds: [],
      meaningfulUpdatedAt: now,
      ...(initialInstructionId === undefined ? {} : { initialInstructionId }),
      ...(parsed.profile === "scout"
        ? {
            effectiveState: resolveScoutEffectiveState(parsed.leasePolicy),
            scout,
          }
        : {}),
    };
    let adapter: ProviderAdapter;
    let preparedInitialPrompt: string | undefined;
    let deferredInitialPrompt: boolean;
    let launchSpec: ProviderLaunchSpec | undefined;
    let sessionRuntime: SessionRuntime;
    let scoutLaunchPhase: NonNullable<ScoutRuntimeState["launchFailure"]>["phase"] = "prepare";
    try {
      if (provisional.profile === "scout" && provisional.scout !== undefined) {
        scoutLaunchPhase = "verify";
        provisional.scout.workspaceStateHash = await this.workspace.captureWorkspaceState(
          provisional.cwd,
        );
      }
      scoutLaunchPhase = "prepare";
      adapter = this.catalog.requireAdapter(parsed.provider);
      preparedInitialPrompt = initialPrompt === undefined
        ? undefined
        : provisional.profile === "scout"
          ? initialPrompt
          : (provisional.kind ?? "worker") === "worker"
          ? addWorkerReportingGuidance(
              applyWorkerMode(initialPrompt, provisional.workerMode),
              provisional.id,
              provisional.executor === "orbstack-container",
            )
          : applyWorkerMode(initialPrompt, provisional.workerMode);
      deferredInitialPrompt = initialPrompt !== undefined
        && adapter.deferInitialPrompt?.(provisional) === true;
      launchSpec = adapter.buildLaunchSpec(
        provisional,
        initialPrompt === undefined || deferredInitialPrompt
          ? undefined
          : preparedInitialPrompt,
      );
      sessionRuntime = await this.assembly.spawnPreparedLaunch(
        adapter,
        provisional,
        launchSpec,
        async () => {
          // Provider and executor preparation have finished. Binding/budget activation and
          // the spawn share one permit; initialization below never holds it.
          if (launchReservation !== undefined) await this.catalog.options.residentLifecycle!.validateReservation(launchReservation);
          await activate?.(cloneRecord(provisional));
          if (initialInstructionId !== undefined || launchReservation !== undefined) await this.catalog.options.store?.put(cloneRecord(provisional));
          this.requireActiveParent(parsed.parentSessionId);
          if (initialPrompt !== undefined && !deferredInitialPrompt) {
            await this.catalog.options.transcripts?.append({
              sessionId: id,
              kind: "prompt",
              source: initialInstructionId === undefined ? "human" : "orchestrator",
              text: initialPrompt,
              data: { initial: true, ...(initialInstructionId === undefined ? {} : { instructionId: initialInstructionId, expectedTurn: 1 }) },
            });
          }
          this.requireActiveParent(parsed.parentSessionId);
        },
        (phase) => {
          scoutLaunchPhase = phase;
          if (phase === "spawn" && launchReservation) this.outcomes.get(id)!.phase = "uncertain";
        },
        admission,
        () => { if (launchReservation) this.outcomes.get(id)!.phase = "failed"; },
      );
      if (launchReservation) {
        const evidence = this.outcomes.get(id)!;
        evidence.runtime = sessionRuntime;
        sessionRuntime.onExit(() => {
          evidence.phase = "failed";
          // Initialization cleanup can detach the ordinary observer before termination arrives.
          this.onLaunchOutcome(id);
        });
      }
    } catch (error) {
      releaseReservation();
      // The worktree was made for a worker that never started, so it holds nothing and belongs to
      // nobody. `discard` still refuses to force, so anything that did land in it survives.
      await this.workspace.discardFailedStart(provisioned);
      if (provisional.profile === "scout" && provisional.scout !== undefined) {
        await this.assembly.preserveFailedScoutLaunch(
          provisional,
          scoutLaunchPhase,
          error,
          launchSpec,
        );
        throw scoutLaunchError(provisional.id, error);
      }
      throw error;
    }
    const record: SessionRecord = {
      ...provisional,
      pid: sessionRuntime.pid,
      executionState: "active",
      updatedAt: new Date().toISOString(),
      launchRecord: resolvedLaunchRecord(launchSpec, "launch"),
    };
    const runtime = this.assembly.createRuntimeSession(record, {
      sessionRuntime,
      watchers: new Map(),
      stopRequested: false,
      launchTail: Promise.resolve(),
    });
    runtime.turns.suppressTurns();
    this.catalog.sessions.set(id, runtime);
    releaseReservation();
    this.observer.adoptSessionRuntime(runtime, sessionRuntime);

    if (record.profile === "scout") {
      try {
        await this.assembly.registerSession(runtime);
      } catch (error) {
        await runtime.scout?.failLive("initialize", error);
        throw scoutLaunchError(record.id, error);
      }
    }

    try {
      const sessionTerminal: ProviderSessionTerminal = {
        snapshot: () => sessionRuntime.snapshot(),
        write: (data) => sessionRuntime.write(data),
        wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      };
      await adapter.initializeSession?.(record, sessionTerminal);
      if (
        runtime.record.profile !== "scout"
        && runtime.record.executionState !== "active"
      ) {
        throw new RegistryError(
          "SESSION_NOT_ACTIVE",
          runtime.turns.latestResult ?? "Provider session exited during initialization",
        );
      }
      runtime.turns.finishInitialization(initialPrompt !== undefined);
      if (
        deferredInitialPrompt
        && initialPrompt !== undefined
        && preparedInitialPrompt !== undefined
      ) {
        await this.catalog.options.transcripts?.append({
          sessionId: id,
          kind: "prompt",
          source: initialInstructionId === undefined ? "human" : "orchestrator",
          text: initialPrompt,
          data: { initial: true, ...(initialInstructionId === undefined ? {} : { instructionId: initialInstructionId, expectedTurn: 1 }) },
        });
        this.requireActiveParent(parsed.parentSessionId);
        runtime.scout?.armBudget();
        if (adapter.submitInputToTerminal !== undefined) {
          await adapter.submitInputToTerminal(preparedInitialPrompt, sessionTerminal);
        } else {
          const data = adapter.submitInput?.(preparedInitialPrompt)
            ?? Buffer.from(`${preparedInitialPrompt}\n`);
          sessionRuntime.write(data);
        }
      } else {
        runtime.scout?.armBudget();
      }
    } catch (error) {
      if (record.profile === "scout") {
        await runtime.scout?.failLive("initialize", error);
        throw scoutLaunchError(record.id, error);
      }
      runtime.turns.releaseTimers();
      if (runtime.sessionRuntime === sessionRuntime) delete runtime.sessionRuntime;
      sessionRuntime.kill();
      this.catalog.sessions.delete(id);
      await this.assembly.cleanupLaunchArtifacts(record, "initialization-failed");
      throw error;
    }

    if (record.profile !== "scout") {
      try {
        await this.assembly.registerSession(runtime);
      } catch (error) {
        sessionRuntime.kill();
        this.catalog.sessions.delete(id);
        await this.assembly.cleanupLaunchArtifacts(record, "launch-failed");
        throw error;
      }
    }

    if (launchReservation) {
      const evidence = this.outcomes.get(id)!;
      if (evidence.phase !== "failed") evidence.phase = "ready";
    }
    return cloneRecord(runtime.record);
  }

  requireActiveParent(parentSessionId: string | undefined): void {
    if (parentSessionId === undefined) return;
    const parent = this.catalog.requireRuntime(parentSessionId);
    if (parent.record.executionState !== "active" || parent.stopRequested) {
      throw new RegistryError(
        "PARENT_SESSION_NOT_ACTIVE",
        `Parent session ${parentSessionId} is not active`,
      );
    }
  }
}
