import { randomUUID } from "node:crypto";
import { orchestratorController, type OrchestratorBinding } from "../domain/orchestrator.js";
import type { SessionRecord } from "../domain/session.js";
import type { ControllerIdentity } from "../domain/worker-coordination.js";
import type { WorkerCoordinationService } from "../broker/worker-coordination.js";
import type { OrchestratorControllerDirectory } from "./orchestrator-controller-directory.js";

interface SessionLivenessRegistry {
  get(sessionId: string): SessionRecord;
  onSessionUpdate(listener: (sessionId: string) => void): () => void;
}

/** Lifecycle observation, not a heartbeat: quiet, blocked and errored live processes keep leases. */
export class OrchestratorSessionLiveness {
  private readonly controllers = new Map<string, { controller: ControllerIdentity; sessionId: string }>();
  private tail: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;

  constructor(private readonly options: {
    directory: OrchestratorControllerDirectory;
    registry: SessionLivenessRegistry;
    coordination: Pick<WorkerCoordinationService, "observeControllerLiveness" | "listControllerLiveness">;
    onError: (error: unknown) => void;
  }) {}

  async start(): Promise<void> {
    // Old bindings may have been reset/replaced. Recheck their durable observations too, so a
    // connected record from the previous broker cannot grant immortality to a missing session.
    for (const entry of this.options.coordination.listControllerLiveness()) {
      if (entry.session !== undefined) this.controllers.set(entry.controller.controllerId, {
        controller: entry.controller, sessionId: entry.session.sessionId,
      });
    }
    for (const entry of await this.options.directory.listControllers()) {
      this.controllers.set(entry.controller.controllerId, entry);
    }
    this.unsubscribe = this.options.registry.onSessionUpdate((sessionId) => {
      // Capture this edge synchronously; a death followed by resume must not become two live reads.
      let record: SessionRecord | undefined;
      try { record = this.record(sessionId); }
      catch (error) { this.options.onError(error); return; }
      for (const entry of this.controllers.values()) {
        if (entry.sessionId === sessionId) {
          void this.enqueue(() => this.observe(entry.controller, sessionId, record))
            .catch(this.options.onError);
        }
      }
    });
    for (const entry of this.controllers.values()) {
      await this.enqueue(() => this.observe(entry.controller, entry.sessionId, this.record(entry.sessionId)));
    }
  }

  /** Activation runs before the launch prompt can dispatch workers; failed creation closes it. */
  async bindingSession(binding: OrchestratorBinding, record?: SessionRecord): Promise<void> {
    const controller = orchestratorController(binding);
    this.controllers.set(controller.controllerId, { controller, sessionId: binding.sessionId });
    await this.enqueue(() => this.observe(controller, binding.sessionId, record));
  }

  async flush(): Promise<void> { await this.tail; }

  dispose(): void { this.unsubscribe?.(); }

  private record(sessionId: string): SessionRecord | undefined {
    try { return this.options.registry.get(sessionId); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error
        && error.code === "SESSION_NOT_FOUND") return undefined;
      throw error;
    }
  }

  private async observe(controller: ControllerIdentity, sessionId: string, record?: SessionRecord): Promise<void> {
    const previous = this.options.coordination.listControllerLiveness()
      .find((entry) => entry.controller.controllerId === controller.controllerId);
    // Execution/attention labels alone are not death: stop/fatal bookkeeping can precede exit.
    // Absence after registry.ready(), or failed creation, confirms no broker-owned process exists.
    const state = record !== undefined && record.exitCode === null ? "connected" : "disconnected";
    const session = { sessionId, generation: record?.generation ?? previous?.session?.generation ?? 1 };
    if (previous?.state === state && previous.session?.sessionId === sessionId
      && previous.session.generation === session.generation) return;
    await this.options.coordination.observeControllerLiveness({
      mutationId: `broker:orc-liveness:${sessionId}:${session.generation}:${state}:${randomUUID()}`,
      actor: controller,
      controller,
      state,
      session,
      reason: state === "connected" ? "broker-managed orchestrator session alive"
        : "broker confirmed orchestrator session exit or absence",
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(action);
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
