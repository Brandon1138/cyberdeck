import type { BrokerRuntimeConfig } from "../config.js";
import type { BrokerEvent } from "../domain/events.js";
import type { JobDispatchAdapter } from "../domain/dispatch.js";
import type { ProviderDescriptor } from "../domain/provider-registration.js";
import { ArtifactStore } from "../persistence/artifact-store.js";
import { JobStore } from "../persistence/job-store.js";
import { LeaseStore } from "../persistence/lease-store.js";
import { AdmissionScheduler, type AdmissionSnapshot } from "./admission-scheduler.js";
import { BudgetLedger, type BudgetReport } from "./budget-ledger.js";
import { JobControlPlane } from "./job-control-plane.js";
import { InMemoryProviderRegistry, defaultProviderRegistry } from "./provider-registry.js";
import {
  ControlPlaneReconciler,
  type ReconciliationReport,
  type RuntimeInspector,
} from "./reconciler.js";
import { WorktreeLeaseManager } from "./worktree-lease-manager.js";

interface JournalLike {
  append(event: BrokerEvent): Promise<void>;
}

export interface ControlPlaneRuntimeOptions {
  stateDirectory: string;
  config: BrokerRuntimeConfig;
  journal?: JournalLike;
  /**
   * Dispatch adapters to compose. Each one's provider id is registered as it is wired in. A factory
   * receives the runtime's own lease manager so an adapter that takes writable leases shares the
   * single durable lease service rather than constructing a second one.
   */
  adapters?: JobDispatchAdapter[] | ((context: { leases: WorktreeLeaseManager }) => JobDispatchAdapter[]);
  /** Extra provider descriptors (display names) for adapters that want a friendlier label. */
  providers?: ProviderDescriptor[];
  runtimes?: RuntimeInspector[];
  now?: () => string;
  idFactory?: () => string;
}

/**
 * Composes the durable control plane with admission, budgets, leases, artifacts, and reconciliation,
 * and owns the ordering the broker depends on.
 *
 * **Startup.** Persistence is constructed first, then durable job state is recovered, then
 * reconciliation runs — and only afterwards is admission opened. Because the scheduler starts
 * closed, a job submitted before or during startup simply waits in the queue: nothing is dispatched
 * against unreconciled state, writable or otherwise.
 *
 * **Shutdown.** Admission is closed *first*, so no new job can start while draining. In-flight jobs
 * are then cancelled through their adapters (which is what makes their final state observable),
 * pending adapter reports are awaited, and every remaining non-terminal job is settled as cancelled
 * so the durable record reflects what actually happened.
 */
export class ControlPlaneRuntime {
  readonly registry: InMemoryProviderRegistry;
  readonly jobStore: JobStore;
  readonly artifacts: ArtifactStore;
  readonly leases: WorktreeLeaseManager;
  readonly scheduler: AdmissionScheduler;
  readonly budgets: BudgetLedger;
  readonly controlPlane: JobControlPlane;
  private readonly reconciler: ControlPlaneReconciler;
  private reconciliation: ReconciliationReport | undefined;
  private started = false;
  private stopped = false;

  constructor(private readonly options: ControlPlaneRuntimeOptions) {
    this.registry = defaultProviderRegistry();
    for (const descriptor of options.providers ?? []) this.registry.register(descriptor);

    this.jobStore = new JobStore(options.stateDirectory);
    this.artifacts = new ArtifactStore(options.stateDirectory);
    this.leases = new WorktreeLeaseManager({
      store: new LeaseStore(options.stateDirectory),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.scheduler = new AdmissionScheduler({
      limits: options.config.concurrency,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.idFactory !== undefined ? { idFactory: options.idFactory } : {}),
    });
    this.budgets = new BudgetLedger({
      declaration: options.config.budget,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.controlPlane = new JobControlPlane({
      registry: this.registry,
      store: this.jobStore,
      scheduler: this.scheduler,
      budgets: this.budgets,
      maxDelegationDepth: options.config.maxDelegationDepth,
      ...(options.journal !== undefined ? { journal: options.journal } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.idFactory !== undefined ? { idFactory: options.idFactory } : {}),
    });
    const adapters =
      typeof options.adapters === "function"
        ? options.adapters({ leases: this.leases })
        : (options.adapters ?? []);
    for (const adapter of adapters) {
      // Registration is what makes an explicitly requested provider selectable. It grants no rank.
      this.registry.register({ id: adapter.provider, displayName: adapter.provider });
      this.controlPlane.registerAdapter(adapter);
    }

    this.reconciler = new ControlPlaneReconciler({
      controlPlane: this.controlPlane,
      leases: this.leases,
      artifacts: this.artifacts,
      ...(options.runtimes !== undefined ? { runtimes: options.runtimes } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }

  /** Recover durable state, reconcile it, then open admission. Safe to call once per process. */
  async start(): Promise<ReconciliationReport> {
    if (this.started) throw new Error("Control-plane runtime is already started");
    this.started = true;
    await this.controlPlane.recover();
    this.reconciliation = await this.reconciler.reconcile();
    this.scheduler.openAdmission();
    // Startup admits only work that was never dispatched; recovery has already interrupted
    // everything whose runtime ownership could not be verified.
    await this.controlPlane.pumpQueue();
    return this.reconciliation;
  }

  /** Close admission, drain in-flight work, and persist the final state. Idempotent. */
  async shutdown(reason: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.scheduler.closeAdmission();

    for (const snapshot of this.controlPlane.listJobs()) {
      const { status } = snapshot.record.lifecycle;
      if (status === "settled") continue;
      await this.controlPlane
        .cancel(snapshot.record.id, `Broker shutdown (${reason})`)
        .catch(() => undefined);
    }
    await this.controlPlane.whenIdle().catch(() => undefined);
  }

  queueSnapshot(): AdmissionSnapshot {
    return this.controlPlane.queueSnapshot();
  }

  budgetReport(): BudgetReport {
    return this.controlPlane.budgetReport();
  }

  /** The findings from the most recent reconciliation pass, or undefined before startup. */
  lastReconciliation(): ReconciliationReport | undefined {
    return this.reconciliation;
  }

  /** Run reconciliation again — after a transport disconnect, for example. */
  async reconcile(): Promise<ReconciliationReport> {
    this.reconciliation = await this.reconciler.reconcile();
    return this.reconciliation;
  }
}
