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
  /** Starts admitted by policy but not yet represented in the catalog. */
  private pendingWorkerStarts = 0;

  constructor(options: SessionLaunchCoordinatorOptions) {
    this.catalog = options.catalog;
    this.workspace = options.workspace;
    this.scoutSupervision = options.scoutSupervision;
    this.assembly = options.assembly;
    this.observer = options.observer;
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
  ): Promise<SessionRecord> {
    const validated = StartSessionRequestSchema.parse(request);
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

    const id = randomUUID();
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
      attentionState: initialPrompt === undefined ? "done" : "working",
      meaningfulUpdatedAt: now,
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
      // A provider whose launch arguments carry the prompt takes its first model turn the moment
      // it spawns, so whatever the caller must make durable — a worker's budget above all — gets
      // its chance before any provider process exists, not merely before initialization.
      await activate?.(cloneRecord(provisional));
      sessionRuntime = await this.assembly.spawnPreparedLaunch(
        adapter,
        provisional,
        launchSpec,
        async () => {
          this.requireActiveParent(parsed.parentSessionId);
          if (initialPrompt !== undefined && !deferredInitialPrompt) {
            await this.catalog.options.transcripts?.append({
              sessionId: id,
              kind: "prompt",
              source: "human",
              text: initialPrompt,
              data: { initial: true },
            });
          }
          this.requireActiveParent(parsed.parentSessionId);
        },
        (phase) => { scoutLaunchPhase = phase; },
      );
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
      runtime.turns.finishInitialization();
      if (
        deferredInitialPrompt
        && initialPrompt !== undefined
        && preparedInitialPrompt !== undefined
      ) {
        await this.catalog.options.transcripts?.append({
          sessionId: id,
          kind: "prompt",
          source: "human",
          text: initialPrompt,
          data: { initial: true },
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
