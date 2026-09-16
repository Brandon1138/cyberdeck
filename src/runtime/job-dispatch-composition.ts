import type { WorkerExecutionPolicy } from "../domain/worker-execution.js";
import type { JobDispatchAdapter } from "../domain/dispatch.js";
import { AntigravityJobDispatchAdapter } from "../providers/antigravity/dispatch-adapter.js";
import { ClaudeJobDispatchAdapter } from "../providers/claude/dispatch-adapter.js";
import { CursorJobDispatchAdapter } from "../providers/cursor/dispatch-adapter.js";
import { enforceJobExecutionPolicy } from "../orchestration/job-execution-policy.js";

/** Runtime composition keeps concrete provider and persistence adapters outside the broker layer. */
export function composeJobDispatchAdapters(context: {
  codex: JobDispatchAdapter;
  executionPolicy?: WorkerExecutionPolicy | undefined; resourceManaged?: boolean;
}): JobDispatchAdapter[] {
  return [
    context.codex,
    new ClaudeJobDispatchAdapter(), new CursorJobDispatchAdapter(), new AntigravityJobDispatchAdapter(),
  ].map(adapter => enforceJobExecutionPolicy(adapter, context.executionPolicy, context.resourceManaged));
}
