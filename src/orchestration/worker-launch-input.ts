import { z } from "zod";
import { WorkerExecutorSchema } from "../domain/worker-execution.js";
import { ProviderIdSchema, ReasoningEffortSchema, SandboxSchema, ApprovalModeSchema, WorkerModeSchema } from "../domain/session.js";
import { WorkerWorkspaceSchema } from "../domain/worker-workspace.js";
import { WorkerBudgetDeclarationSchema } from "../domain/worker-budget.js";
import { ScoutBriefSchema, WorkerLeasePolicySchema } from "../domain/worker-profile.js";

export const AgentStandardWorkerInputSchema = z.object({
  profile: z.undefined().optional(),
  brief: z.undefined().optional(),
  leasePolicy: z.undefined().optional(),
  provider: ProviderIdSchema,
  model: z.string().optional(),
  effort: ReasoningEffortSchema.optional(),
  cwd: z.string().min(1),
  sandbox: SandboxSchema.default("read-only"),
  executor: WorkerExecutorSchema.optional(),
  executionProfile: z.string().max(64).optional(),
  approvalMode: ApprovalModeSchema.optional(),
  prompt: z.string().trim().min(1),
  name: z.string().optional(),
  /**
   * Where the work lives, when the dispatch knows. Declaring it lets the broker check the worktree,
   * the branch, and the base before a process exists, and lets the launch grant the writable roots
   * the declared provisioning mode needs. Omitted, the worker is validated exactly as before.
   */
  workspace: WorkerWorkspaceSchema.optional(),
  /**
   * Per-spawn override of the box `caveman-workers` default (MIK-79). Orchestrator spawns are
   * caveman by default when the operator has that box preference on; passing "normal" here opts
   * this one spawn out, e.g. a research worker the orchestrator wants to read eloquent. Composer
   * launches (Fleet's `session.start`/`session.startWithPrompt`) never consult this default at
   * all and are always "normal".
   */
  workerMode: WorkerModeSchema.optional(),
  /** Broker-owned allowance. Omission preserves unbudgeted worker behavior. */
  budget: WorkerBudgetDeclarationSchema.optional(),
});
export const AgentScoutWorkerInputSchema = z.object({
  profile: z.literal("scout"),
  cwd: z.string().min(1),
  brief: ScoutBriefSchema,
  leasePolicy: WorkerLeasePolicySchema.optional(),
  name: z.string().optional(),
}).strict();
