import { SessionCatalog } from "./session-catalog.js";
import type { InstructionDelivery } from "./session-ports.js";
import {
  RegistryError,
  type AttachmentMode,
  type ExitSink,
  type FailureSink,
  type OutputSink,
} from "./session-registry-ports.js";
import {
  requireInteractiveInput,
  requireSessionRuntime,
  requireTerminalFinalizationComplete,
  updateAttachmentState,
} from "./session-runtime-guards.js";
import { SessionUpdateBus } from "./session-update-bus.js";

export interface SessionIoSurfaceOptions {
  catalog: SessionCatalog;
  bus: SessionUpdateBus;
}

/**
 * Every way a client reaches a running session, and every refusal that guards them.
 *
 * Attaching, typing, submitting a message, queueing an instruction, and resizing are one surface
 * because they share one set of preconditions — an active record, a settled terminal finalization,
 * an interactive input surface, and the client that actually holds control. Splitting them apart is
 * how a caller ends up with an input path that skips a check the others make.
 */
export class SessionIoSurface {
  private readonly catalog: SessionCatalog;
  private readonly bus: SessionUpdateBus;

  constructor(options: SessionIoSurfaceOptions) {
    this.catalog = options.catalog;
    this.bus = options.bus;
  }

  async attach(
    sessionId: string,
    clientId: string,
    mode: AttachmentMode,
    output: OutputSink,
    ended: ExitSink = () => {},
    failed: FailureSink = () => {},
  ): Promise<Buffer> {
    const runtime = this.catalog.requireRuntime(sessionId);
    requireTerminalFinalizationComplete(runtime);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active; resume it before attaching");
    }
    const sessionRuntime = requireSessionRuntime(runtime);
    if (mode === "control") {
      if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
        throw new RegistryError("SESSION_ALREADY_CONTROLLED", "Session already has a controller");
      }
      runtime.controller = { clientId, output, ended, failed };
      runtime.watchers.delete(clientId);
    } else {
      runtime.watchers.set(clientId, { output, ended, failed });
    }
    updateAttachmentState(runtime);
    try {
      await this.catalog.appendEvent("session.attached", sessionId, { clientId, mode });
    } catch (error) {
      if (runtime.controller?.clientId === clientId) delete runtime.controller;
      runtime.watchers.delete(clientId);
      updateAttachmentState(runtime);
      throw error;
    }
    return sessionRuntime.snapshot();
  }

  async detach(sessionId: string, clientId: string): Promise<void> {
    const runtime = this.catalog.requireRuntime(sessionId);
    let detached = false;
    let controllerReleased = false;
    if (runtime.controller?.clientId === clientId) {
      delete runtime.controller;
      detached = true;
      controllerReleased = true;
    }
    if (runtime.watchers.delete(clientId)) {
      detached = true;
    }
    if (!detached) return;
    updateAttachmentState(runtime);
    await this.catalog.appendEvent("session.detached", sessionId, { clientId });
    if (controllerReleased) this.bus.notifyControllerReleased(sessionId);
  }

  async releaseClient(clientId: string): Promise<void> {
    for (const sessionId of this.catalog.sessions.keys()) {
      await this.detach(sessionId, clientId);
    }
  }

  async write(sessionId: string, clientId: string | undefined, data: Buffer): Promise<void> {
    const runtime = this.catalog.requireRuntime(sessionId);
    this.catalog.assertMayConsume(sessionId);
    requireTerminalFinalizationComplete(runtime);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    requireInteractiveInput(runtime);
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    requireSessionRuntime(runtime).write(data);
    await this.catalog.appendEvent("session.input", sessionId, { bytes: data.length });
  }

  async submit(sessionId: string, clientId: string | undefined, message: string): Promise<void> {
    this.catalog.assertMayConsume(sessionId);
    const runtime = this.catalog.requireRuntime(sessionId);
    requireTerminalFinalizationComplete(runtime);
    requireInteractiveInput(runtime);
    const adapter = this.catalog.requireAdapter(runtime.record.provider);
    const data = adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
    runtime.turns.resetStallObservation();
    await this.catalog.appendTranscript(sessionId, "prompt", "human", message, {});
    await this.catalog.setAttention(runtime, "working", true);
    await this.write(sessionId, clientId, data);
  }

  /**
   * Put one instruction in front of a worker, and report only what actually happened.
   *
   * The old contract wrote the payload to the runtime unconditionally and let the caller record
   * `delivered`. Bytes written at a terminal are not delivery: a worker sitting at a permission
   * modal is not reading its composer, so the entire instruction stayed there unsent while the
   * orchestrator had been told it landed, and the worker's next turn — a stale one — settled the
   * wait that was asking about it.
   *
   * Two rules replace that. The payload is never written at an unsafe boundary, so nothing lands in
   * a composer nobody is going to submit; and the strongest state this call can return is
   * `rendered`, because submission is something the broker observes afterwards rather than something
   * it may assume.
   */
  async submitInstruction(
    sessionId: string,
    message: string,
    source: "orchestrator" | "worker" | "broker" = "orchestrator",
    metadata: Record<string, unknown> = {},
    instructionId?: string,
  ): Promise<InstructionDelivery> {
    this.catalog.assertMayConsume(sessionId);
    const runtime = this.catalog.requireRuntime(sessionId);
    if (runtime.record.executionState === "active" && runtime.controller !== undefined) {
      throw new RegistryError("SESSION_BUSY", "A human controller currently owns this thread");
    }
    if (runtime.record.executionState === "active") requireInteractiveInput(runtime);
    return runtime.turns.submitInstruction({
      message,
      encoded: () => {
        const adapter = this.catalog.requireAdapter(runtime.record.provider);
        return adapter.submitInput?.(message) ?? Buffer.from(`${message}\n`);
      },
      source,
      metadata,
      ...(instructionId === undefined ? {} : { instructionId }),
    });
  }

  resize(sessionId: string, clientId: string | undefined, cols: number, rows: number): void {
    const runtime = this.catalog.requireRuntime(sessionId);
    requireTerminalFinalizationComplete(runtime);
    if (runtime.record.executionState !== "active") {
      throw new RegistryError("SESSION_NOT_ACTIVE", "Session is not active");
    }
    if (runtime.controller !== undefined && runtime.controller.clientId !== clientId) {
      throw new RegistryError("NOT_SESSION_CONTROLLER", "Another client controls this session");
    }
    requireSessionRuntime(runtime).resize(cols, rows);
  }

  snapshot(sessionId: string): Buffer {
    return this.catalog.requireRuntime(sessionId).sessionRuntime?.snapshot() ?? Buffer.alloc(0);
  }

  ownsProcess(sessionId: string): boolean {
    return this.catalog.requireRuntime(sessionId).sessionRuntime !== undefined;
  }

  isStopRequested(sessionId: string): boolean {
    return this.catalog.requireRuntime(sessionId).stopRequested;
  }

  stopRequestedAt(sessionId: string): string | undefined {
    return this.catalog.requireRuntime(sessionId).stopRequestedAt;
  }
}
