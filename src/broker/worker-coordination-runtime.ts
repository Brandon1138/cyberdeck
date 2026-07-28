import type { SessionRecord } from "../domain/session.js";
import type { ControllerIdentity } from "../domain/worker-coordination.js";
import type { OrchestratorStore } from "../persistence/orchestrator-store.js";
import {
  migrateLegacyWorkerSessions,
  type LegacyWorkerMigrationResult,
} from "../persistence/migrations/0001-worker-coordination.js";
import { WorkerCoordinationStore } from "../persistence/worker-coordination-store.js";
import { WorkerCoordinationService, type WorkerCoordinationOptions } from "./worker-coordination.js";

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
      resolveStableController: async (parentSessionId, worker) =>
        this.resolveStableController(parentSessionId, worker),
    });
    return this.migration;
  }

  migrationResult(): LegacyWorkerMigrationResult | undefined {
    return this.migration;
  }

  private async resolveStableController(
    parentSessionId: string,
    worker: SessionRecord,
  ): Promise<ControllerIdentity | undefined> {
    const binding = await this.options.orchestrators?.findBySessionId(parentSessionId);
    if (binding === undefined || binding.key.includes(":peer:")) return undefined;
    const controllerId = `orchestrator:${binding.key}`;
    return {
      controllerId,
      familyId: controllerId,
      scope: binding.scope.kind === "fleet"
        ? { kind: "fleet", scopeId: binding.key }
        : {
            kind: "worktree",
            scopeId: binding.key,
            worktreePath: worker.cwd,
          },
    };
  }
}
