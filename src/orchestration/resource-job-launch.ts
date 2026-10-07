import { DispatchRequestSchema, type DispatchRequest } from "../domain/dispatch.js";
import type { SessionRecord } from "../domain/session.js";
import type { SessionRuntime } from "../domain/session-runtime.js";
import type { ResourceSessionLaunchPort } from "../domain/resource-runtime.js";

export interface JobProcessIdentityHandle {
  readonly pid?: number | undefined;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError?(listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): void;
}
export interface ResourceJobLaunchPort {
  start<T extends JobProcessIdentityHandle>(request: DispatchRequest, prepare: () => T | Promise<T>): Promise<T>;
  cancelStart(jobId: string): boolean;
}
export interface ResourceJobLaunchOptions {
  gate: ResourceSessionLaunchPort;
  /** Validate current canonical request, correlation and launchable lifecycle on every call.
   * Return the jobId as id and generation 1: a job is one immutable attempt, never resumed.
   * Parent/family selection belongs to canonical composition, never ID parsing here. */
  resolveRecord(request: DispatchRequest): SessionRecord | Promise<SessionRecord>;
}

/** Adapts bounded-job processes to the shared durable gate without inventing a second lease. */
export class ResourceJobLaunch implements ResourceJobLaunchPort {
  private readonly pending = new Map<string, { cancelled: boolean }>();
  constructor(private readonly options: ResourceJobLaunchOptions) {}
  async start<T extends JobProcessIdentityHandle>(input: DispatchRequest, prepare: () => T | Promise<T>): Promise<T> {
    const request = DispatchRequestSchema.parse(input);
    if (this.pending.has(request.jobId)) throw new Error("RESOURCE_JOB_LAUNCH_BUSY");
    const pending = { cancelled: false }; this.pending.set(request.jobId, pending);
    let process: T | undefined;
    try {
      const record = await this.record(request);
      if (pending.cancelled) throw new Error("RESOURCE_QUEUE_CANCELLED");
      await this.options.gate.start(record, async () => {
        // Capacity waits cannot turn a cancelled/replaced canonical job into new work.
        const current = await this.record(request);
        if (pending.cancelled) throw new Error("RESOURCE_QUEUE_CANCELLED");
        if (current.parentSessionId !== record.parentSessionId) throw new Error("RESOURCE_JOB_AUTHORITY_CHANGED");
        process = await prepare();
        process = bufferProcess(process);
        if (!Number.isSafeInteger(process.pid) || process.pid! <= 0) throw new Error("RESOURCE_JOB_PID_UNAVAILABLE");
        return runtime(process);
      });
      if (!process) throw new Error("RESOURCE_JOB_PROCESS_UNAVAILABLE");
      return process;
    } catch (error) {
      try { process?.kill("SIGTERM"); } catch { /* The gate retains unknown native lifetime. */ }
      throw error;
    } finally { this.pending.delete(request.jobId); }
  }
  cancelStart(jobId: string): boolean {
    const pending = this.pending.get(jobId);
    if (!pending) return false;
    pending.cancelled = true; this.options.gate.cancelStart(jobId); return true;
  }
  private async record(request: DispatchRequest): Promise<SessionRecord> {
    const record = await this.options.resolveRecord(request), expected = request.request;
    if (record.id !== request.jobId || record.generation !== 1 || record.kind !== "worker" || record.executor !== "host"
      || record.provider !== expected.provider || record.cwd !== expected.cwd || record.sandbox !== expected.sandbox
      || record.model !== expected.model) throw new Error("RESOURCE_JOB_RECORD_MISMATCH");
    return record;
  }
}

/** Exit/error can arrive while libproc capture and binding fsync are pending. Replay to late
 * adapter/gate subscribers; stdout remains paused until the adapter attaches its own decoder. */
function bufferProcess<T extends JobProcessIdentityHandle>(process: T): T {
  let exit: [number | null, NodeJS.Signals | null] | undefined, error: Error | undefined;
  const exits = new Set<Parameters<T["onExit"]>[0]>(), errors = new Set<(error: Error) => void>();
  process.onExit((code, signal) => { exit = [code, signal]; for (const listener of exits) listener(code, signal); });
  process.onError?.(value => { error = value; for (const listener of errors) listener(value); });
  return new Proxy(process, { get(target, key) {
    if (key === "onExit") return (listener: Parameters<T["onExit"]>[0]) => { exits.add(listener); if (exit) listener(...exit); };
    if (key === "onError" && target.onError) return (listener: (error: Error) => void) => { errors.add(listener); if (error) listener(error); };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
function runtime(process: JobProcessIdentityHandle): SessionRuntime {
  return { pid: process.pid!, kill: signal => process.kill(signal as NodeJS.Signals | undefined),
    write() { throw new Error("RESOURCE_JOB_RUNTIME_CONTROL_UNSUPPORTED"); },
    resize() { throw new Error("RESOURCE_JOB_RUNTIME_CONTROL_UNSUPPORTED"); }, snapshot: () => Buffer.alloc(0), onOutput: () => () => {},
    onExit(listener) {
      let subscribed = true;
      process.onExit(code => { if (subscribed) listener(code ?? 1); });
      return () => { subscribed = false; };
    } };
}
