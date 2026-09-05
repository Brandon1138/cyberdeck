import { z } from "zod";

export const WorkerExecutorSchema = z.enum(["host", "orbstack-container"]);
export type WorkerExecutor = z.infer<typeof WorkerExecutorSchema>;
export const WorkerExecutionRequestSchema = z.object({
  executor: WorkerExecutorSchema,
  profile: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
}).strict();
export type WorkerExecutionRequest = z.infer<typeof WorkerExecutionRequestSchema>;
export const ExecutionIdentitySchema = z.object({
  brokerId: z.uuid(), executionId: z.uuid(), workerId: z.uuid(), sessionId: z.uuid(),
  generation: z.number().int().positive(),
});
export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;
export const ExecutionRefSchema = ExecutionIdentitySchema.extend({
  executor: WorkerExecutorSchema, workspaceId: z.string().min(1), backendId: z.string().min(1).optional(),
});
export type ExecutionRef = z.infer<typeof ExecutionRefSchema>;
export interface ExecutionInspection {
  ref: ExecutionRef;
  state: "absent" | "stopped" | "running" | "unreachable";
  guestExitCode?: number;
  oomKilled?: boolean;
}
export const ExecutionRecordSchema = z.object({
  schemaVersion: z.literal(1), ref: ExecutionRefSchema, request: WorkerExecutionRequestSchema,
  phase: z.enum(["reserved", "preparing", "ready", "running", "stopping", "stopped", "collecting", "retained", "destroyed", "failed"]),
  updatedAt: z.iso.datetime(), failure: z.enum(["prepare", "start", "persistence", "recovery"]).optional(),
  cleanupFailed: z.boolean().optional(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export const WorkerExecutionPolicySchema = z.object({
  defaultExecutor: WorkerExecutorSchema.default("host"),
  hostProfile: z.string().default("host-compatible"),
  containerProfile: z.string().default("ordinary"),
}).strict();
export type WorkerExecutionPolicy = z.infer<typeof WorkerExecutionPolicySchema>;

/** Selection is independent of provider flags and never substitutes an available backend. */
export function resolveWorkerExecution(
  input: { executor?: WorkerExecutor | undefined; executionProfile?: string | undefined; kind?: "worker" | "orchestrator" | undefined },
  policy: WorkerExecutionPolicy = WorkerExecutionPolicySchema.parse({}),
): WorkerExecutionRequest {
  if (input.kind === "orchestrator" && input.executor === "orbstack-container") {
    throw new ExecutionError("ORCHESTRATOR_EXECUTOR_UNSUPPORTED");
  }
  const executor = input.executor ?? (input.kind === "orchestrator" ? "host" : policy.defaultExecutor);
  const profile = executor === "host" ? policy.hostProfile : policy.containerProfile;
  if (input.executionProfile !== undefined && input.executionProfile !== profile) {
    throw new ExecutionError("EXECUTION_PROFILE_REFUSED");
  }
  return WorkerExecutionRequestSchema.parse({ executor, profile });
}

export class ExecutionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ExecutionError"; }
}
