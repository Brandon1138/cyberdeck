import { z } from "zod";
import { OrchestratorBindingSchema, STRIGOI_KEY, type OrchestratorBinding } from "./orchestrator.js";
import { ReasoningEffortSchema } from "./session.js";

export { STRIGOI_KEY } from "./orchestrator.js";
export const STRIGOI_LIMITS = {
  checkpointProseBytes: 32 * 1024,
  packetManifestBytes: 256 * 1024,
  sourceReferencesPerPage: 64,
  sourceTextBytesPerPage: 32 * 1024,
} as const;

export function isStrigoiBinding(binding: OrchestratorBinding): boolean {
  return binding.kind === "resident" && binding.key === STRIGOI_KEY;
}

export const StrigoiIdentitySchema = z.object({ sessionId: z.uuid(), incarnation: z.number().int().positive(), generation: z.number().int().positive() });
export const StrigoiSelectionSchema = z.object({ provider: z.literal("codex"), model: z.string().min(1), effort: ReasoningEffortSchema.optional(), cwd: z.string().min(1) });
export const StrigoiDesiredSchema = z.enum(["enabled", "suspended", "disabled"]);
export const StrigoiPhaseSchema = z.enum(["requested", "checkpointing", "sealed", "retiring", "launching", "committed", "adopting", "reconciling", "complete", "aborted"]);
export const StrigoiSourceRefSchema = z.object({ kind: z.enum(["turn", "instruction", "worker-event", "attention", "workflow", "artifact"]), id: z.string().min(1), revision: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export const StrigoiPacketRefSchema = z.object({ artifactId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), coverageId: z.string().min(1) });
export const StrigoiHoldSchema = z.object({ code: z.string().min(1), detail: z.string().min(1), sourceIds: z.array(z.string()) });
export const StrigoiTransitionSchema = z.object({
  id: z.string().min(1), expectedIncarnation: z.number().int().nonnegative(), reason: z.string().min(1), phase: StrigoiPhaseSchema,
  predecessor: StrigoiIdentitySchema.optional(), successor: StrigoiIdentitySchema.optional(), packet: StrigoiPacketRefSchema.optional(),
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.iso.datetime().optional(),
}).refine((transition) => transition.predecessor === undefined || transition.predecessor.incarnation === transition.expectedIncarnation,
  "Predecessor must match expected incarnation")
  .refine((transition) => transition.successor === undefined || transition.successor.incarnation > transition.expectedIncarnation,
    "Successor incarnation must increase");
export const StrigoiStateSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), desired: StrigoiDesiredSchema,
  selection: StrigoiSelectionSchema.optional(), activeBinding: OrchestratorBindingSchema.optional(), incarnation: z.number().int().nonnegative(),
  transition: StrigoiTransitionSchema.optional(), latestPacket: StrigoiPacketRefSchema.optional(), retainedSessionIds: z.array(z.uuid()),
  hold: StrigoiHoldSchema.optional(), updatedAt: z.iso.datetime(),
}).refine((state) => state.desired !== "enabled" || state.selection !== undefined, "Enabled resident requires a selection")
  .refine((state) => state.activeBinding === undefined || (isStrigoiBinding(state.activeBinding)
    && state.activeBinding.resident?.incarnation === state.incarnation), "Active binding must match resident incarnation")
  .refine((state) => state.transition === undefined || state.incarnation === state.transition.expectedIncarnation
    || state.incarnation === state.transition.successor?.incarnation, "State incarnation must belong to the transition")
  .refine((state) => {
    const binding = state.activeBinding;
    if (binding === undefined || state.transition === undefined) return true;
    return [state.transition.predecessor, state.transition.successor].every((identity) =>
      identity === undefined || identity.incarnation !== state.incarnation || identity.sessionId === binding.sessionId);
  }, "Active binding and transition identity must agree");

export type StrigoiIdentity = z.infer<typeof StrigoiIdentitySchema>;
export type StrigoiSelection = z.infer<typeof StrigoiSelectionSchema>;
export type StrigoiDesired = z.infer<typeof StrigoiDesiredSchema>;
export type StrigoiPhase = z.infer<typeof StrigoiPhaseSchema>;
export type StrigoiSourceRef = z.infer<typeof StrigoiSourceRefSchema>;
export type StrigoiPacketRef = z.infer<typeof StrigoiPacketRefSchema>;
export type StrigoiHold = z.infer<typeof StrigoiHoldSchema>;
export type StrigoiTransition = z.infer<typeof StrigoiTransitionSchema>;
export type StrigoiState = z.infer<typeof StrigoiStateSchema>;
