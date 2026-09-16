import type { WorkerExecutionPolicy } from "../domain/worker-execution.js";
import type { JobDispatchAdapter } from "../domain/dispatch.js";
import { AntigravityJobDispatchAdapter } from "../providers/antigravity/dispatch-adapter.js";
import { ClaudeJobDispatchAdapter } from "../providers/claude/dispatch-adapter.js";
import { CursorJobDispatchAdapter } from "../providers/cursor/dispatch-adapter.js";
import { enforceJobExecutionPolicy } from "../orchestration/job-execution-policy.js";
import type { ResourceJobLaunchPort } from "../orchestration/resource-job-launch.js";

/** Runtime composition keeps concrete provider and persistence adapters outside the broker layer. */
export function composeJobDispatchAdapters(context: {
  codex: JobDispatchAdapter;
  executionPolicy?: WorkerExecutionPolicy | undefined; resourceManaged?: boolean;
  resourceLaunch?: ResourceJobLaunchPort;
}): JobDispatchAdapter[] {
  const options = context.resourceLaunch ? { resourceLaunch: context.resourceLaunch } : {};
  return [
    context.codex,
    new ClaudeJobDispatchAdapter(options), new CursorJobDispatchAdapter(options), new AntigravityJobDispatchAdapter(options),
  ].map(adapter => enforceJobExecutionPolicy(adapter, context.executionPolicy, context.resourceManaged, context.resourceLaunch !== undefined));
}
