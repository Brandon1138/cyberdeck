import type { SessionRuntime, SessionRuntimeFactory } from "../../domain/session-runtime.js";
import type { ExecutionInspection, ExecutionRef } from "../../domain/worker-execution.js";
import type { CollectedExecution, ExecutionLaunchInput, PreparedExecution, WorkerExecutionPort } from "../../orchestration/session/execution-ports.js";
import type { ProviderLaunchSpec } from "../../orchestration/session/provider-ports.js";

/** Host transport retains its existing bytes, permissions and process-control semantics. */
export class HostExecutor implements WorkerExecutionPort {
  private readonly running = new Map<string, SessionRuntime>();
  constructor(private readonly factory: SessionRuntimeFactory<ProviderLaunchSpec>) {}
  async prepare(input: ExecutionLaunchInput): Promise<PreparedExecution> {
    if (input.request.executor !== "host") throw new Error("EXECUTOR_MISMATCH");
    return { ref: { ...input.identity, executor: "host", workspaceId: input.record.cwd }, launch: input.launch };
  }
  async start(prepared: PreparedExecution, replayBytes: number): Promise<SessionRuntime> {
    if (this.running.has(prepared.ref.executionId)) throw new Error("EXECUTION_ALREADY_RUNNING");
    const runtime = this.factory(prepared.launch, replayBytes);
    this.running.set(prepared.ref.executionId, runtime);
    runtime.onExit(() => { if (this.running.get(prepared.ref.executionId) === runtime) this.running.delete(prepared.ref.executionId); });
    return runtime;
  }
  async inspect(ref: ExecutionRef): Promise<ExecutionInspection> {
    return { ref, state: this.running.has(ref.executionId) ? "running" : "stopped" };
  }
  async stop(ref: ExecutionRef, force: boolean): Promise<ExecutionInspection> {
    this.running.get(ref.executionId)?.kill(force ? "SIGKILL" : "SIGTERM");
    return this.inspect(ref);
  }
  async collect(_ref: ExecutionRef): Promise<CollectedExecution> {
    return { manifestRef: "", complete: false }; // Host artifact collectors retain their own policy.
  }
  async destroy(ref: ExecutionRef): Promise<void> {
    if (this.running.has(ref.executionId)) throw new Error("EXECUTION_STILL_RUNNING");
  }
}
