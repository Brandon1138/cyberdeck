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
export const StrigoiSourceRefSchema = z.object({ kind: z.enum(["turn", "instruction", "worker-event", "attention", "workflow", "artifact"]), id: z.string().min(1), revision: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  coverageSourceId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  copy: z.object({ artifactId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  sessionIds: z.array(z.uuid()).optional(), part: z.number().int().nonnegative().optional(), text: z.string().optional(),
});
export const StrigoiPacketRefSchema = z.object({ artifactId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), coverageId: z.string().min(1) });
export const StrigoiHoldSchema = z.object({ code: z.string().min(1), detail: z.string().min(1), sourceIds: z.array(z.string()) });
const SuccessionTurnSchema = z.object({
  id: z.uuid(), attempt: z.number().int().min(1).max(2), startedAt: z.iso.datetime(),
  outcome: z.enum(["unknown", "completed", "terminated"]),
  endedAt: z.iso.datetime().optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }).optional(),
}).strict();
export const StrigoiTransitionSchema = z.object({
  id: z.string().min(1), expectedIncarnation: z.number().int().nonnegative(), reason: z.string().min(1), phase: StrigoiPhaseSchema,
  predecessor: StrigoiIdentitySchema.optional(), successor: StrigoiIdentitySchema.optional(), packet: StrigoiPacketRefSchema.optional(),
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.iso.datetime().optional(),
  requestedAt: z.iso.datetime().optional(), phaseTimes: z.record(z.string(), z.iso.datetime()).optional(),
  retirementConfirmedAt: z.iso.datetime().optional(), stopRequestedAt: z.iso.datetime().optional(),
  launchStartedAt: z.iso.datetime().optional(), checkpointTurn: SuccessionTurnSchema.optional(), adoptionTurn: SuccessionTurnSchema.optional(),
  packetBytes: z.number().int().nonnegative().optional(), recovery: z.boolean().optional(),
  lastMutationId: z.string().optional(),
  adoptionDeferred: z.boolean().optional(),
  turnHistory: z.array(SuccessionTurnSchema.extend({ kind: z.enum(["checkpoint", "adoption"]) })).optional(),
}).refine((transition) => transition.predecessor === undefined || transition.predecessor.incarnation === transition.expectedIncarnation,
  "Predecessor must match expected incarnation")
  .refine((transition) => transition.successor === undefined || transition.successor.incarnation > transition.expectedIncarnation,
    "Successor incarnation must increase");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const StrigoiArtifactRefSchema = z.object({ artifactId: z.uuid(), sha256: digest }).strict();
const prose = z.string().refine((value) => Buffer.byteLength(value, "utf8") <= STRIGOI_LIMITS.checkpointProseBytes, "Prose exceeds UTF-8 byte limit");
export const StrigoiPacketSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]), author: StrigoiIdentitySchema, createdAt: z.iso.datetime(), prose,
  coverageId: z.uuid(), sourceCount: z.number().int().nonnegative(), inventory: StrigoiArtifactRefSchema.optional(),
  inventoryPages: z.number().int().positive().optional(),
}).strict().refine((p) => (p.sourceCount === 0) === (p.inventory === undefined), "Inventory/count mismatch")
  .refine((p) => p.schemaVersion === 1 ? p.inventoryPages === undefined : (p.sourceCount === 0) === (p.inventoryPages === undefined), "Page index/count mismatch");
export const StrigoiAdoptionSchema = z.object({
  identity: StrigoiIdentitySchema, packetHash: digest, coverageId: z.uuid(),
  handledSourceIds: z.array(digest).refine((ids) => new Set(ids).size === ids.length, "Duplicate handled IDs"),
  account: prose.refine((value) => value.trim().length > 0, "Adoption account required"),
}).strict();
export const StrigoiContinuityReceiptSchema = z.object({
  mutationId: z.string().min(1), requestHash: digest, packet: StrigoiPacketRefSchema,
  adoption: StrigoiAdoptionSchema.optional(),
}).strict();
export type StrigoiArtifactRef = z.infer<typeof StrigoiArtifactRefSchema>;
export type StrigoiPacket = z.infer<typeof StrigoiPacketSchema>;
export type StrigoiAdoption = z.infer<typeof StrigoiAdoptionSchema>;
export const StrigoiStateSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), desired: StrigoiDesiredSchema,
  selection: StrigoiSelectionSchema.optional(), activeGeneration: z.number().int().positive().optional(), activeBinding: OrchestratorBindingSchema.optional(), incarnation: z.number().int().nonnegative(),
  transition: StrigoiTransitionSchema.optional(), latestPacket: StrigoiPacketRefSchema.optional(), retainedSessionIds: z.array(z.uuid()),
  successionRequests: z.array(z.object({ mutationId: z.string(), expectedIncarnation: z.number().int(), reason: z.string(), transitionId: z.string() })).optional(),
  successionHistory: z.array(StrigoiTransitionSchema).optional(),
  continuityReceipts: z.array(StrigoiContinuityReceiptSchema).optional(),
  continuationHolds: z.array(StrigoiHoldSchema).optional(),
  hold: StrigoiHoldSchema.optional(), updatedAt: z.iso.datetime(),
}).refine((state) => state.desired !== "enabled" || state.selection !== undefined, "Enabled resident requires a selection")
  .refine((state) => state.activeBinding === undefined || (isStrigoiBinding(state.activeBinding)
    && state.activeBinding.resident?.incarnation === state.incarnation), "Active binding must match resident incarnation")
  .refine((state) => (state.activeBinding === undefined) === (state.activeGeneration === undefined), "Active binding requires its generation")
  .refine((state) => state.transition === undefined || state.incarnation === state.transition.expectedIncarnation
    || state.incarnation === state.transition.successor?.incarnation, "State incarnation must belong to the transition")
  .refine((state) => {
    const binding = state.activeBinding;
    if (binding === undefined || state.transition === undefined) return true;
    return [state.transition.predecessor, state.transition.successor].every((identity) =>
      identity === undefined || identity.incarnation !== state.incarnation || (identity.sessionId === binding.sessionId && identity.generation === state.activeGeneration));
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

/** Derived operator display data, never a launch, grant or delivery authority. */
export interface StrigoiFleetView {
  canonical: boolean;
  incarnation?: number;
  desired: StrigoiDesired;
  readiness: "passive" | "held" | "unconfigured" | "ready";
  adoption: "not-required" | "pending" | "acknowledged";
  hold?: StrigoiHold;
  continuationHolds: StrigoiHold[];
}
