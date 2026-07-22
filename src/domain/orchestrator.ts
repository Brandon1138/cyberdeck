import { z } from "zod";
import { CapabilityGrantSchema } from "./capability.js";
import { ProviderIdSchema, SandboxSchema } from "./session.js";

export const OrchestratorScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), cwd: z.string().min(1) }),
  z.object({ kind: z.literal("fleet") }),
]);

export const OrchestratorBindingSchema = z.object({
  key: z.string().min(1),
  sessionId: z.uuid(),
  provider: ProviderIdSchema,
  model: z.string().optional(),
  cwd: z.string().min(1),
  sandbox: SandboxSchema,
  scope: OrchestratorScopeSchema,
  grant: CapabilityGrantSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const EnsureOrchestratorRequestSchema = z.object({
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  cwd: z.string().min(1),
  scope: z.enum(["workspace", "fleet"]).default("workspace"),
});

export const ResetOrchestratorRequestSchema = EnsureOrchestratorRequestSchema.pick({
  cwd: true,
  scope: true,
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
export type OrchestratorBindingReset = z.infer<typeof OrchestratorBindingResetSchema>;

export function orchestratorKey(scope: OrchestratorScope): string {
  return scope.kind === "fleet" ? "fleet" : `workspace:${scope.cwd}`;
}
