import { z } from "zod";
import { schemaVersionField } from "./control-plane.js";
import {
  ControllerIdentitySchema,
  WorkerLifecycleSchema,
} from "./worker-coordination.js";

export const HANDOFF_LIMITS = {
  directiveChars: 2_048,
  manifestEntries: 64,
} as const;

/**
 * One worker as the receiving orchestrator is told about it.
 *
 * Everything here is what the recipient needs in order to act without first re-deriving the fleet:
 * which thread, what it was dispatched as, where it is working, and who held it a moment ago.
 * `priorControllerId` is absent for a worker the operator was running themselves — the honest
 * answer, and the one that distinguishes "taken from another Orc" from "handed over by hand".
 */
export const HandoffManifestEntrySchema = z.object({
  workerId: z.uuid(),
  taskId: z.string().min(1).max(256),
  waveId: z.string().min(1).max(256).optional(),
  /** The thread's operator-facing name, when it has one. */
  name: z.string().min(1).max(256).optional(),
  worktreePath: z.string().min(1).max(1_024).optional(),
  lifecycle: WorkerLifecycleSchema,
  priorControllerId: z.string().min(1).max(256).optional(),
});

/**
 * A directed handoff: the operator moved these workers onto one orchestrator, and said why.
 *
 * The record is durable because the delivery is not. An orchestrator is a conversation with a
 * context window and a restart, so a directive pushed into its composer can be missed, truncated,
 * or spent before the worker leases it describes matter. This record outlives all of that: it is
 * written in the same fsynced transaction as the lease transfer it announces, and it stays
 * `pending` until the recipient reads it back — after which the same log line records that it was
 * consumed exactly once.
 */
export const WorkerHandoffSchema = z.object({
  schemaVersion: schemaVersionField,
  handoffId: z.uuid(),
  /** The durable controller the leases moved to, derived from its binding and nothing else. */
  recipient: ControllerIdentitySchema,
  /** The conversation to nudge. Delivery detail only: authority lives in `recipient`. */
  recipientSessionId: z.uuid(),
  /** Who ordered the move. Operator-initiated handoffs record the broker. */
  issuedBy: ControllerIdentitySchema,
  directive: z.string().trim().min(1).max(HANDOFF_LIMITS.directiveChars),
  manifest: z.array(HandoffManifestEntrySchema).min(1).max(HANDOFF_LIMITS.manifestEntries),
  issuedAt: z.iso.datetime(),
  state: z.enum(["pending", "consumed"]),
  consumedAt: z.iso.datetime().optional(),
});

export type HandoffManifestEntry = z.infer<typeof HandoffManifestEntrySchema>;
export type WorkerHandoff = z.infer<typeof WorkerHandoffSchema>;

/**
 * The prose an orchestrator is handed, from the record and nothing else.
 *
 * Both delivery paths render from here — the composer nudge and the `worker_events` pickup — so a
 * recipient that read one and then the other is never told two different things about the same
 * handoff.
 */
export function handoffBriefing(handoff: WorkerHandoff): string {
  const roster = handoff.manifest.map((entry) => {
    const label = entry.name === undefined ? entry.workerId : `${entry.name} (${entry.workerId})`;
    const origin = entry.priorControllerId === undefined
      ? "previously operator-held"
      : `previously ${entry.priorControllerId}`;
    return `- ${label} · ${entry.lifecycle} · ${origin}${
      entry.worktreePath === undefined ? "" : ` · ${entry.worktreePath}`
    }`;
  });
  return [
    `Cyberdeck handoff ${handoff.handoffId}. You now hold the lease on ${handoff.manifest.length} worker${
      handoff.manifest.length === 1 ? "" : "s"
    }.`,
    `Directive: ${handoff.directive}`,
    "Adopted workers:",
    ...roster,
    "These leases are already yours; use cyberdeck_worker_ctl and cyberdeck_worker_events directly, without adopting again.",
  ].join("\n");
}
