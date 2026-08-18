import { z } from "zod";
import { CapabilityGrantSchema, type CyberdeckCapability } from "./capability.js";
import {
  ApprovalModeSchema,
  ProviderIdSchema,
  ReasoningEffortSchema,
  SandboxSchema,
} from "./session.js";
import type { ControllerIdentity } from "./worker-coordination.js";

export const OrchestratorScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), cwd: z.string().min(1) }),
  z.object({ kind: z.literal("fleet") }),
]);

/**
 * What a binding *is*, in one word, on the record itself.
 *
 * `primary` is the one binding a scope answers with: exactly one per `fleet` or
 * `workspace:<cwd>` key, replaced by rebinding. `peer` is an additional orchestrator bound to that
 * same scope alongside it — `cyberdeck_orchestrator_create` makes one, and it never consults or
 * replaces the primary.
 */
export const OrchestratorBindingKindSchema = z.enum(["primary", "peer"]);

/** The marker a peer key carries between its scope's key and the peer session's own id. */
const PEER_KEY_MARKER = ":peer:";

const OrchestratorBindingRecordSchema = z.object({
  key: z.string().min(1),
  /**
   * Absent in every binding written before MIK-98. Those records are still on disk in an
   * append-only log, so the field is optional on read and filled in from a peer key's structural
   * session-id suffix, which is how peer-ness was recorded before it had a name. New records write
   * it explicitly, and that persisted value is authoritative.
   */
  kind: OrchestratorBindingKindSchema.optional(),
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

export const OrchestratorBindingSchema = OrchestratorBindingRecordSchema
  .transform((record) => ({
    ...record,
    kind: record.kind ?? bindingKindFromKey(record.key, record.sessionId),
  }))
  .refine(
    (binding) => binding.kind === "primary"
      || peerPrimaryKey(binding.key, binding.sessionId) !== undefined,
    "A peer binding's key must end with its :peer:<sessionId> suffix",
  );

/**
 * Every capability a binding is granted, primary or peer.
 *
 * There is one list because there is one authority. A binding that may `thread.enqueue` to a worker
 * is a binding the lease substrate must accept as that worker's controller, so a peer either holds
 * this whole list and a durable controller identity, or neither. That invariant is what MIK-98
 * closed: `orchestratorController` below is total, so no binding can be handed a capability the
 * lease substrate would then refuse to honor for it.
 */
export const ORCHESTRATOR_GRANT_CAPABILITIES: readonly CyberdeckCapability[] = [
  "thread.list",
  "thread.read",
  "thread.enqueue",
  "worker.start",
  "orchestrator.inspect",
  "orchestrator.stop",
  "workflow.run",
];

export const EnsureOrchestratorRequestSchema = z.object({
  provider: ProviderIdSchema.optional(),
  model: z.string().optional(),
  effort: ReasoningEffortSchema.optional(),
  approvalMode: ApprovalModeSchema.optional(),
  cwd: z.string().min(1),
  scope: z.enum(["workspace", "fleet"]).default("fleet"),
});

export const CreateOrchestratorRequestSchema = EnsureOrchestratorRequestSchema.extend({
  provider: ProviderIdSchema,
  model: z.string().trim().min(1),
});

export const ResetOrchestratorRequestSchema = EnsureOrchestratorRequestSchema.pick({
  cwd: true,
  scope: true,
});

/**
 * One operator toggle of one durable delegation grant on one scope's binding. `enabled` absent
 * reads the current state without writing.
 */
export const OrchestratorGrantToggleRequestSchema = ResetOrchestratorRequestSchema.extend({
  enabled: z.boolean().optional(),
});

export const FableWorkersRequestSchema = OrchestratorGrantToggleRequestSchema;

export const CavemanWorkersRequestSchema = z.object({
  enabled: z.boolean().optional(),
});

export const OrchestratorBindingResetSchema = z.object({
  recordType: z.literal("reset"),
  key: z.string().min(1),
  resetAt: z.iso.datetime(),
});

export type OrchestratorScope = z.infer<typeof OrchestratorScopeSchema>;
export type OrchestratorBindingKind = z.infer<typeof OrchestratorBindingKindSchema>;
export type OrchestratorBinding = z.infer<typeof OrchestratorBindingSchema>;
export type EnsureOrchestratorRequest = z.infer<typeof EnsureOrchestratorRequestSchema>;
export type CreateOrchestratorRequest = z.infer<typeof CreateOrchestratorRequestSchema>;
export type ResetOrchestratorRequest = z.infer<typeof ResetOrchestratorRequestSchema>;
export type OrchestratorGrantToggleRequest = z.infer<typeof OrchestratorGrantToggleRequestSchema>;
export type FableWorkersRequest = z.infer<typeof FableWorkersRequestSchema>;
export type CavemanWorkersRequest = z.infer<typeof CavemanWorkersRequestSchema>;
export type OrchestratorBindingReset = z.infer<typeof OrchestratorBindingResetSchema>;

export interface OrchestratorGrantToggleResult {
  key: string;
  configured: boolean;
  enabled: boolean;
  sessionId?: string;
}

export type FableWorkersResult = OrchestratorGrantToggleResult;

export interface CavemanWorkersResult {
  scope: "box";
  enabled: boolean;
}

export function orchestratorKey(scope: OrchestratorScope): string {
  return scope.kind === "fleet" ? "fleet" : `workspace:${scope.cwd}`;
}

/** The durable controller id a binding proves, primary or peer. One key, one controller. */
export function orchestratorControllerId(key: string): string {
  return `orchestrator:${key}`;
}

/** The key of a peer bound alongside `primaryKey`, named by the peer session it belongs to. */
export function peerOrchestratorKey(primaryKey: string, sessionId: string): string {
  return `${primaryKey}${PEER_KEY_MARKER}${sessionId}`;
}

/** The scope key a binding belongs to: its own for a primary, its primary's for a peer. */
export function primaryOrchestratorKey(key: string): string {
  return peerPrimaryKey(key) ?? key;
}

function bindingKindFromKey(key: string, sessionId: string): OrchestratorBindingKind {
  return peerPrimaryKey(key, sessionId) === undefined ? "primary" : "peer";
}

/** Parse only the suffix emitted by `peerOrchestratorKey`, never marker text inside a cwd. */
function peerPrimaryKey(key: string, expectedSessionId?: string): string | undefined {
  const marker = key.lastIndexOf(PEER_KEY_MARKER);
  if (marker === -1) return undefined;
  const sessionId = key.slice(marker + PEER_KEY_MARKER.length);
  if (expectedSessionId === undefined) {
    if (!z.uuid().safeParse(sessionId).success) return undefined;
  } else if (sessionId !== expectedSessionId) {
    return undefined;
  }
  return key.slice(0, marker);
}

/**
 * The one derivation of a binding's durable controller identity. Every caller — the orchestrator
 * control plane, the worker reporting channel, the legacy migration, and Fleet's ownership lens —
 * reads it from here, because three private copies of this rule is exactly how a peer came to be
 * allowed to enqueue to a worker it was then refused control and observation of (MIK-98).
 *
 * A peer is a controller in its own right: a distinct `controllerId`, so two peers of one scope can
 * never take each other's leases, inside the scope's `familyId`, so a peer's workers belong to the
 * same orchestrator family as the primary's rather than to a conversation that ends. Nothing here
 * is derived from a session: the peer's key is durable in the binding log, and the identity it
 * proves survives a broker restart exactly as a primary's does.
 */
export function orchestratorController(binding: OrchestratorBinding): ControllerIdentity {
  const primaryKey = binding.kind === "peer" ? primaryOrchestratorKey(binding.key) : binding.key;
  return {
    controllerId: orchestratorControllerId(binding.key),
    familyId: orchestratorControllerId(primaryKey),
    scope: binding.scope.kind === "fleet"
      ? { kind: "fleet", scopeId: binding.key }
      : { kind: "worktree", scopeId: binding.key, worktreePath: binding.scope.cwd },
  };
}
