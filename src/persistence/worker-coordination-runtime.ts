import type { SessionRecord } from "../domain/session.js";
import type { ControllerIdentity } from "../domain/worker-coordination.js";
import { orchestratorController } from "../domain/orchestrator.js";
import type { OrchestratorStore } from "./orchestrator-store.js";
import {
  migrateLegacyWorkerSessions,
  type LegacyWorkerMigrationResult,
} from "./migrations/0001-worker-coordination.js";
import { WorkerCoordinationStore } from "./worker-coordination-store.js";
import { WorkerCoordinationService, type WorkerCoordinationOptions } from "../broker/worker-coordination.js";

export interface WorkerCoordinationRuntimeOptions {
  stateDirectory: string;
  recoveredSessions?: readonly SessionRecord[];
  orchestrators?: OrchestratorStore;
  service?: Omit<WorkerCoordinationOptions, "store">;
}

/** Broker composition boundary. Startup replays durable state before legacy binding migration. */
export class WorkerCoordinationRuntime {
  readonly store: WorkerCoordinationStore;
  readonly service: WorkerCoordinationService;
  private started = false;
  private migration: LegacyWorkerMigrationResult | undefined;

  constructor(private readonly options: WorkerCoordinationRuntimeOptions) {
    this.store = new WorkerCoordinationStore(options.stateDirectory);
    this.service = new WorkerCoordinationService({
      store: this.store,
      ...options.service,
    });
  }

  async start(): Promise<LegacyWorkerMigrationResult> {
    if (this.started) throw new Error("Worker coordination runtime is already started");
    this.started = true;
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
