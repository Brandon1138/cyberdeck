import { z } from "zod";
import { CapabilityGrantSchema } from "./capability.js";
import { ProviderIdSchema, ReasoningEffortSchema, SandboxSchema } from "./session.js";

export const OrchestratorScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), cwd: z.string().min(1) }),
  z.object({ kind: z.literal("fleet") }),
]);

export const OrchestratorBindingSchema = z.object({
  key: z.string().min(1),
  sessionId: z.uuid(),
  provider: ProviderIdSchema,
  model: z.string().optional(),
  effort: ReasoningEffortSchema.optional(),
  cwd: z.string().min(1),
  sandbox: SandboxSchema,
  scope: OrchestratorScopeSchema,
  grant: CapabilityGrantSchema,
  /** Legacy field retained only so pre-box-preference binding records remain readable. */
  workerPreferences: z.object({
    caveman: z.boolean().optional(),
  }).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const EnsureOrchestratorRequestSchema = z.object({
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  effort: ReasoningEffortSchema.optional(),
  cwd: z.string().min(1),
  scope: z.enum(["workspace", "fleet"]).default("fleet"),
});

export const ResetOrchestratorRequestSchema = EnsureOrchestratorRequestSchema.pick({
  cwd: true,
  scope: true,
});

export const FableWorkersRequestSchema = ResetOrchestratorRequestSchema.extend({
  enabled: z.boolean().optional(),
});

export const CavemanWorkersRequestSchema = z.object({
  enabled: z.boolean().optional(),
});

export const OrchestratorBindingResetSchema = z.object({
  recordType: z.literal("reset"),
  key: z.string().min(1),
  resetAt: z.iso.datetime(),
});

export type OrchestratorScope = z.infer<typeof OrchestratorScopeSchema>;
export type OrchestratorBinding = z.infer<typeof OrchestratorBindingSchema>;
export type EnsureOrchestratorRequest = z.infer<typeof EnsureOrchestratorRequestSchema>;
export type ResetOrchestratorRequest = z.infer<typeof ResetOrchestratorRequestSchema>;
export type FableWorkersRequest = z.infer<typeof FableWorkersRequestSchema>;
export type CavemanWorkersRequest = z.infer<typeof CavemanWorkersRequestSchema>;
export type OrchestratorBindingReset = z.infer<typeof OrchestratorBindingResetSchema>;

export interface FableWorkersResult {
  key: string;
  configured: boolean;
  enabled: boolean;
  sessionId?: string;
}

export interface CavemanWorkersResult {
  scope: "box";
  enabled: boolean;
}

export function orchestratorKey(scope: OrchestratorScope): string {
  return scope.kind === "fleet" ? "fleet" : `workspace:${scope.cwd}`;
}
