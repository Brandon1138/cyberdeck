import { randomUUID } from "node:crypto";
import { orchestratorController, type OrchestratorBinding } from "../domain/orchestrator.js";
import type { SessionRecord } from "../domain/session.js";
import type { ControllerIdentity } from "../domain/worker-coordination.js";
import type { WorkerCoordinationService } from "../broker/worker-coordination.js";
import type { OrchestratorControllerDirectory } from "./orchestrator-controller-directory.js";
import type { WorkerLeaseCredentialCustodian } from "../broker/worker-lease-credential-custodian.js";

interface SessionLivenessRegistry {
  get(sessionId: string): SessionRecord;
  onSessionUpdate(listener: (sessionId: string) => void): () => void;
  ownsProcess?(sessionId: string): boolean;
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
    withAuthority?: <T>(work: () => Promise<T>) => Promise<T>;
    custody?: { credentials: WorkerLeaseCredentialCustodian; subjects: Pick<WorkerCoordinationService, "listSubjects"> };
  }) {}

  async start(): Promise<void> {
    for (const entry of await this.options.directory.listControllers()) {
      this.controllers.set(entry.controller.controllerId, entry);
    }
    // A durable observation cannot restore authority after its binding was reset/replaced,
    // even if the old process is still alive. Only current bindings receive session updates.
    for (const entry of this.options.coordination.listControllerLiveness()) {
      if (entry.session !== undefined && !this.controllers.has(entry.controller.controllerId)) {
        await this.enqueue(() => this.observe(entry.controller, entry.session!.sessionId, undefined,
          "broker confirmed orchestrator binding removal"));
      }
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
    // Binding callbacks may already own authority. Never wait for the observation tail here:
    // an older queued edge can itself be waiting to acquire that same authority.
    await this.authority(async () => {
      if ((await this.options.directory.forController(controller.controllerId))?.sessionId !== binding.sessionId) return;
      this.controllers.set(controller.controllerId, { controller, sessionId: binding.sessionId });
      await this.observe(controller, binding.sessionId, record);
    });
  }

  /** Losing the binding revokes ownership even when the session's process is still alive. */
  async bindingRemoved(binding: OrchestratorBinding): Promise<void> {
    const controller = orchestratorController(binding);
    await this.authority(async () => {
      const current = await this.options.directory.forController(controller.controllerId);
      if (current && current.sessionId !== binding.sessionId) return;
      this.controllers.delete(controller.controllerId);
      await this.observe(controller, binding.sessionId, undefined, "broker confirmed orchestrator binding removal");
    });
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

  private async observe(controller: ControllerIdentity, sessionId: string, record?: SessionRecord,
    disconnectedReason = "broker confirmed orchestrator session exit or absence"): Promise<void> {
    const current = await this.options.directory.forController(controller.controllerId);
    if (current ? current.sessionId !== sessionId : record !== undefined) return;
    const previous = this.options.coordination.listControllerLiveness()
      .find((entry) => entry.controller.controllerId === controller.controllerId);
    // Execution/attention labels alone are not death: stop/fatal bookkeeping can precede exit.
    // Absence after registry.ready(), or failed creation, confirms no broker-owned process exists.
    const state = record !== undefined && record.exitCode === null
      && (!current?.resident || this.options.registry.ownsProcess?.(sessionId) !== false) ? "connected" : "disconnected";
    // Do not lend a new resident's liveness to predecessor tokens lost with the broker.
    // Keep the original disconnect/grace until those leases are eligible for ordinary adoption.
    // Usable same-controller custody during planned renewal still connects immediately.
    const custody = this.options.custody;
    if (state === "connected" && current?.resident && custody
      && previous?.state === "disconnected" && custody.subjects.listSubjects().some((subject) =>
        subject.lease.controller?.controllerId === controller.controllerId && ["active", "contested"].includes(subject.lease.state)
        && custody.credentials.get(controller.controllerId, subject.subjectId)?.leaseVersion !== subject.lease.version)) return;
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
        : disconnectedReason,
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(() => this.authority(action));
    this.tail = operation.catch(() => undefined);
    return operation;
  }
  private authority<T>(work: () => Promise<T>): Promise<T> {
    return this.options.withAuthority ? this.options.withAuthority(work) : work();
  }
}
