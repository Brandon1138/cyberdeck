import type { SessionRecord } from "../domain/session.js";
import type { ControllerIdentity } from "../domain/worker-coordination.js";
import { orchestratorController } from "../domain/orchestrator.js";
import type { OrchestratorStore } from "./orchestrator-store.js";
import {
  migrateLegacyWorkerSessions,
  type LegacyWorkerCoordinationPort,
  type LegacyWorkerMigrationResult,
} from "./migrations/0001-worker-coordination.js";
import {
  WorkerCoordinationStore,
  type WorkerCoordinationCompaction,
} from "./worker-coordination-store.js";

export interface WorkerCoordinationRuntimeService extends LegacyWorkerCoordinationPort {
  initialize(): Promise<void>;
}

export interface WorkerCoordinationRuntimeOptions<Service extends WorkerCoordinationRuntimeService> {
  stateDirectory: string;
  recoveredSessions?: readonly SessionRecord[];
  orchestrators?: OrchestratorStore;
  createService(store: WorkerCoordinationStore): Service;
}

/** Durable startup boundary. Composition supplies service; startup replays state before migration. */
export class WorkerCoordinationRuntime<Service extends WorkerCoordinationRuntimeService> {
  readonly store: WorkerCoordinationStore;
  readonly service: Service;
  private started = false;
  private migration: LegacyWorkerMigrationResult | undefined;
  private compaction: WorkerCoordinationCompaction | undefined;

  constructor(private readonly options: WorkerCoordinationRuntimeOptions<Service>) {
    this.store = new WorkerCoordinationStore(options.stateDirectory);
    this.service = options.createService(this.store);
  }

  async start(): Promise<LegacyWorkerMigrationResult> {
    if (this.started) throw new Error("Worker coordination runtime is already started");
    this.started = true;
    // Before the fold, not after: an uncompacted log is what makes the fold expensive, and past
    // V8's string cap it is what stops the broker from starting at all.
    this.compaction = await this.store.compactIfLarge();
    await this.service.initialize();
    this.migration = await migrateLegacyWorkerSessions({
      sessions: this.options.recoveredSessions ?? [],
      coordination: this.service,
      resolveStableController: async (parentSessionId) =>
        this.resolveStableController(parentSessionId),
    });
    return this.migration;
  }

  migrationResult(): LegacyWorkerMigrationResult | undefined {
    return this.migration;
  }

  compactionResult(): WorkerCoordinationCompaction | undefined {
    return this.compaction;
  }

  /**
   * A legacy worker's parent resolves to whatever durable identity its binding proves — peer
   * bindings included, since MIK-98 gave them one. Only a parent with no binding at all is
   * unresolved, and its worker still migrates as orphaned rather than crediting a conversation.
   */
  private async resolveStableController(
    parentSessionId: string,
  ): Promise<ControllerIdentity | undefined> {
    const binding = await this.options.orchestrators?.findBySessionId(parentSessionId);
    return binding === undefined ? undefined : orchestratorController(binding);
  }
}
