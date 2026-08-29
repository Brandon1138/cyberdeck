import type { ResolvedLaunchRecord, SessionRecord, StartSessionRequest } from "../domain/session.js";
import type { ScoutDecisionCard } from "../domain/scout-output.js";
import type { ScoutArtifactKind } from "../domain/worker-profile.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import { checkSessionCwdAccessible } from "../orchestration/session/session-cwd-check.js";
import { SessionCatalog } from "../orchestration/session/session-catalog.js";
import { SessionIoSurface } from "../orchestration/session/session-io-surface.js";
import { SessionLaunchCoordinator } from "../orchestration/session/session-launch-coordinator.js";
import { SessionLifecycleController } from "../orchestration/session/session-lifecycle-controller.js";
import { SessionReadModel } from "../orchestration/session/session-read-model.js";
import { SessionRuntimeAssembly } from "../orchestration/session/session-runtime-assembly.js";
import { SessionRuntimeObserver } from "../orchestration/session/session-runtime-observer.js";
import { SessionUpdateBus } from "../orchestration/session/session-update-bus.js";
import { SessionWaitCoordinator } from "../orchestration/session/session-wait-coordinator.js";
import { SessionWorkspaceCoordinator } from "../orchestration/session/session-workspace-coordinator.js";
import { ScoutSessionSupervisorFactory } from "../orchestration/session/scout-session-supervisor.js";
import type {
  InstructionDelivery,
  InstructionStateUpdate,
  ScoutArtifactRead,
  WorkerWaitResult,
  WorkerWaitTarget,
} from "../orchestration/session/session-ports.js";
import type {
  AttachmentMode,
  ExitSink,
  FailureSink,
  OutputSink,
  ReattachTarget,
  SessionRegistryOptions,
  SessionTreeProgress,
  WorkerBudgetGate,
  WorkerBudgetObservation,
} from "../orchestration/session/session-registry-ports.js";

export type {
  InstructionDelivery,
  InstructionStateUpdate,
  WorkerResultSnapshot,
  WorkerWaitResult,
  WorkerWaitTarget,
} from "../orchestration/session/session-ports.js";

/**
 * The registry's own contracts are declared next to the collaborators that implement them and are
 * offered here, because this class is what every caller composes against: `SessionRegistryOptions`
 * is this constructor's argument and `RegistryError` is what its callers catch, whichever module
 * they happen to be declared in.
 */
export { RegistryError } from "../orchestration/session/session-registry-ports.js";
export type {
  AttachmentMode,
  ExitSink,
  FailureSink,
  OutputSink,
  ReattachTarget,
  SessionRegistryOptions,
  SessionTreeProgress,
  WorkerBudgetGate,
  WorkerBudgetObservation,
} from "../orchestration/session/session-registry-ports.js";

/**
 * The single public face of session lifecycle, and the composition that gives it one.
 *
 * Everything a session can be asked to do still arrives here, and nothing below is reachable from
 * outside: callers hold a `SessionRegistry`, not a launch coordinator or a catalog. What each
 * collaborator owns is stated where it lives — this class owns the wiring and the guarantee that
 * there is exactly one of each, so no two paths can decide the same session's state independently.
 */
export class SessionRegistry {
  private readonly catalog: SessionCatalog;
  private readonly bus: SessionUpdateBus;
  /** Owns cwd refusal, worktree provisioning and rollback, and Scout workspace verification. */
  private readonly workspace: SessionWorkspaceCoordinator;
  /** Builds the per-session supervisor a Scout needs, and nothing at all for any other session. */
  private readonly scoutSupervision: ScoutSessionSupervisorFactory;
  private readonly assembly: SessionRuntimeAssembly;
  private readonly observer: SessionRuntimeObserver;
  private readonly io: SessionIoSurface;
  private readonly reads: SessionReadModel;
  private readonly wait: SessionWaitCoordinator;
  private readonly lifecycle: SessionLifecycleController;
  private readonly launch: SessionLaunchCoordinator;
  private readonly recovery: Promise<void>;

  constructor(options: SessionRegistryOptions) {
    if (options.workerTurnObservation === undefined) {
      throw new TypeError("SessionRegistry requires workerTurnObservation");
    }
    this.catalog = new SessionCatalog(options);
    this.bus = new SessionUpdateBus();
    this.workspace = new SessionWorkspaceCoordinator({
      journal: {
        workspaceProvisioned: (sessionId, facts) =>
          this.catalog.appendEvent("workspace.provisioned", sessionId, { ...facts }),
      },
      validateCwd: options.validateCwd ?? checkSessionCwdAccessible,
      ...(options.scoutWorkspaceState === undefined
        ? {}
        : { workspaceState: options.scoutWorkspaceState }),
      ...(options.worktreeProvisioner === undefined
        ? {}
        : { provisioner: options.worktreeProvisioner }),
    });
    this.scoutSupervision = new ScoutSessionSupervisorFactory({
      workspace: this.workspace,
      ...(options.scoutReports === undefined ? {} : { reports: options.scoutReports }),
    });
    this.assembly = new SessionRuntimeAssembly({
      catalog: this.catalog,
      bus: this.bus,
      scoutSupervision: this.scoutSupervision,
    });
    this.observer = new SessionRuntimeObserver({
      catalog: this.catalog,
      bus: this.bus,
      assembly: this.assembly,
      // Retirement is lifecycle authority, and a terminal exit is the moment to ask for it. The
      // indirection is the cycle: the controller that retires a thread is also the one whose stop
      // and resume the observer publishes for.
      sweepRetention: () => this.lifecycle.sweepRetention(),
    });
    this.io = new SessionIoSurface({ catalog: this.catalog, bus: this.bus });
    this.reads = new SessionReadModel(this.catalog);
    this.wait = new SessionWaitCoordinator({ catalog: this.catalog, bus: this.bus });
    this.lifecycle = new SessionLifecycleController({
      catalog: this.catalog,
      bus: this.bus,
      assembly: this.assembly,
      observer: this.observer,
    });
    this.launch = new SessionLaunchCoordinator({
      catalog: this.catalog,
      workspace: this.workspace,
      scoutSupervision: this.scoutSupervision,
      assembly: this.assembly,
      observer: this.observer,
    });
    this.recovery = this.assembly.recover(options.recoveredSessions ?? []);
  }

  async ready(): Promise<void> {
    await this.recovery;
  }

  setWorkerBudgetGate(gate: WorkerBudgetGate): void {
    return this.catalog.setWorkerBudgetGate(gate);
  }

  onControllerReleased(listener: (sessionId: string) => void): () => void {
    return this.bus.onControllerReleased(listener);
  }

  async start(
    request: StartSessionRequest,
    initialPrompt?: string,
    activate?: (record: SessionRecord) => Promise<void>,
  ): Promise<SessionRecord> {
    return this.launch.start(request, initialPrompt, activate);
  }

  list(): SessionRecord[] {
    return this.reads.list();
  }

  workerCapacity(): { activeWorkers: number; maxConcurrentWorkers: number | null } {
    return this.reads.workerCapacity();
  }

  get(sessionId: string): SessionRecord {
    return this.reads.get(sessionId);
  }

  async readScoutArtifact(
    sessionId: string,
    artifact: ScoutArtifactKind,
    afterByte = 0,
    maxBytes = 16 * 1024,
  ): Promise<ScoutArtifactRead> {
    return this.reads.readScoutArtifact(sessionId, artifact, afterByte, maxBytes);
  }

  scoutDecisionCard(sessionId: string): ScoutDecisionCard | undefined {
    return this.reads.scoutDecisionCard(sessionId);
  }

  launchRecord(sessionId: string): ResolvedLaunchRecord | undefined {
    return this.reads.launchRecord(sessionId);
  }

  resolveReattachTarget(sessionId: string): ReattachTarget {
    return this.reads.resolveReattachTarget(sessionId);
  }

  async waitForWorkerResults(
    targets: readonly WorkerWaitTarget[],
    timeoutMs: number,
    maxResultChars = 1_200,
  ): Promise<WorkerWaitResult> {
    return this.wait.waitForWorkerResults(targets, timeoutMs, maxResultChars);
  }

  onSessionUpdate(listener: (sessionId: string) => void): () => void {
    return this.bus.onSessionUpdate(listener);
  }

  async attach(
    sessionId: string,
    clientId: string,
    mode: AttachmentMode,
    output: OutputSink,
    ended: ExitSink = () => {},
    failed: FailureSink = () => {},
  ): Promise<Buffer> {
    return this.io.attach(sessionId, clientId, mode, output, ended, failed);
  }

  async detach(sessionId: string, clientId: string): Promise<void> {
    return this.io.detach(sessionId, clientId);
  }

  async releaseClient(clientId: string): Promise<void> {
    return this.io.releaseClient(clientId);
  }

  async write(sessionId: string, clientId: string | undefined, data: Buffer): Promise<void> {
    return this.io.write(sessionId, clientId, data);
  }

  async submit(sessionId: string, clientId: string | undefined, message: string): Promise<void> {
    return this.io.submit(sessionId, clientId, message);
  }

  async submitInstruction(
    sessionId: string,
    message: string,
    source: "orchestrator" | "worker" | "broker" = "orchestrator",
    metadata: Record<string, unknown> = {},
    instructionId?: string,
  ): Promise<InstructionDelivery> {
    return this.io.submitInstruction(sessionId, message, source, metadata, instructionId);
  }

  onDeliveryBoundary(listener: (sessionId: string) => void): () => void {
    return this.bus.onDeliveryBoundary(listener);
  }

  onInstructionState(listener: (update: InstructionStateUpdate) => void): () => void {
    return this.bus.onInstructionState(listener);
  }

  workerTruth(sessionId: string): WorkerTruth {
    return this.reads.workerTruth(sessionId);
  }

  workerBudgetObservation(sessionId: string): WorkerBudgetObservation {
    return this.reads.workerBudgetObservation(sessionId);
  }

  resize(sessionId: string, clientId: string | undefined, cols: number, rows: number): void {
    return this.io.resize(sessionId, clientId, cols, rows);
  }

  snapshot(sessionId: string): Buffer {
    return this.io.snapshot(sessionId);
  }

  ownsProcess(sessionId: string): boolean {
    return this.io.ownsProcess(sessionId);
  }

  isStopRequested(sessionId: string): boolean {
    return this.io.isStopRequested(sessionId);
  }

  stopRequestedAt(sessionId: string): string | undefined {
    return this.io.stopRequestedAt(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    return this.lifecycle.stop(sessionId);
  }

  forceStop(sessionId: string): void {
    return this.lifecycle.forceStop(sessionId);
  }

  async stopTree(sessionId: string): Promise<SessionTreeProgress> {
    return this.lifecycle.stopTree(sessionId);
  }

  async stopAll(): Promise<void> {
    return this.lifecycle.stopAll();
  }

  async resume(sessionId: string): Promise<SessionRecord> {
    return this.lifecycle.resume(sessionId);
  }

  async delete(sessionId: string, beforeDelete?: () => Promise<void>): Promise<void> {
    return this.lifecycle.delete(sessionId, beforeDelete);
  }

  async rename(sessionId: string, name: string): Promise<SessionRecord> {
    return this.lifecycle.rename(sessionId, name);
  }

  async togglePin(sessionId: string): Promise<SessionRecord> {
    return this.lifecycle.togglePin(sessionId);
  }

  async reorder(sessionId: string, direction: "up" | "down"): Promise<SessionRecord[]> {
    return this.lifecycle.reorder(sessionId, direction);
  }

  async sweepRetention(now: number = Date.now()): Promise<string[]> {
    return this.lifecycle.sweepRetention(now);
  }}
