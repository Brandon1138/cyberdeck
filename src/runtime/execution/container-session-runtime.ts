import type { SessionRuntime } from "../../domain/session-runtime.js";
import type { ExecutionRef } from "../../domain/worker-execution.js";
import type { OrbStackClient } from "./orbstack-client.js";

/** Attach pid is host-only. Exit/stop publication waits for inspected guest state. */
export class ContainerSessionRuntime implements SessionRuntime {
  private readonly exits = new Set<(code: number, signal?: number) => void>();
  private outcome: number | undefined;
  private finalizing: Promise<void> | undefined;
  private escalating: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private forceRequested = false;
  constructor(private readonly attach: SessionRuntime, private readonly client: OrbStackClient,
    private readonly ref: ExecutionRef, private readonly released: () => void,
    private readonly failure: (error: unknown) => void,
  ) { attach.onExit(() => { void this.finish(false); }); }
  get pid(): number { return this.attach.pid; }
  write(data: Buffer): void { this.attach.write(data); }
  snapshot(): Buffer { return this.attach.snapshot(); }
  onOutput(listener: (chunk: Buffer) => void): () => void { return this.attach.onOutput(listener); }
  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
    this.attach.resize(cols, rows);
    void this.client.resize(this.ref, cols, rows).catch(this.failure);
  }
  kill(signal?: string): void { void this.finish(signal === "SIGKILL"); }
  onExit(listener: (code: number, signal?: number) => void): () => void {
    this.exits.add(listener);
    if (this.outcome !== undefined) queueMicrotask(() => { if (this.exits.has(listener)) listener(this.outcome!); });
    return () => { this.exits.delete(listener); };
  }
  private finish(force: boolean): Promise<void> {
    this.forceRequested ||= force;
    if (this.outcome !== undefined) return Promise.resolve();
    if (this.finalizing !== undefined) {
      // SIGKILL must reach the guest while a graceful Docker stop is still pending.
      if (force && this.escalating === undefined) {
        this.escalating = this.completeStop(true).finally(() => { this.escalating = undefined; });
      }
      return this.escalating ?? this.finalizing;
    }
    this.finalizing = (async () => {
      try { await this.completeStop(force); }
      finally { this.finalizing = undefined; }
    })();
    return this.finalizing;
  }
  private async completeStop(force: boolean): Promise<void> {
    try {
      // A lost attach client cannot leave a live, unsupervised guest writing indefinitely.
      const inspected = await this.client.stop(this.ref, force);
      if (this.outcome !== undefined) return;
      if (inspected === undefined) throw new Error("CONTAINER_EXIT_EVIDENCE_MISSING");
      if (inspected.State.Running) throw new Error("CONTAINER_STOP_UNCONFIRMED");
      this.outcome = inspected.State.ExitCode;
      clearTimeout(this.retry);
      this.attach.kill();
      this.released();
      for (const listener of this.exits) listener(this.outcome);
    } catch (error) {
      if (this.outcome === undefined) {
        this.failure(error);
        if (this.retry === undefined) this.retry = setTimeout(() => {
          this.retry = undefined; void this.finish(this.forceRequested);
        }, 5000).unref();
      }
    }
  }
}
