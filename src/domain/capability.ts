import { z } from "zod";

export const CyberdeckCapabilitySchema = z.enum([
  "thread.list",
  "thread.read",
  "thread.enqueue",
  "worker.start",
  "worker.start.fable",
  "orchestrator.inspect",
  "orchestrator.stop",
  "workflow.run",
]);

/**
 * Capability names this build no longer knows, dropped on read instead of refused.
 *
 * `worker.start.cursor` gated Cursor dispatch per orchestrator and defaulted off, which the
 * capability catalog never said — it advertises Cursor's whole model list to everyone (MIK-96).
 * The gate is gone, but bindings written while an operator had it switched on are still on disk in
 * an append-only log, so the name has to keep parsing. It parses as nothing: a retired name grants
 * nothing and denies nothing, and a binding carrying one stays readable.
 */
const RETIRED_CAPABILITIES = new Set<string>(["worker.start.cursor"]);

export const CapabilityGrantSchema = z.object({
  subjectSessionId: z.uuid(),
  capabilities: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((entry) => typeof entry !== "string" || !RETIRED_CAPABILITIES.has(entry))
        : value,
    z.array(CyberdeckCapabilitySchema),
  ),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("workspace"), cwd: z.string().min(1) }),
    z.object({ kind: z.literal("fleet") }),
    z.object({ kind: z.literal("self") }),
  ]),
});

export type CyberdeckCapability = z.infer<typeof CyberdeckCapabilitySchema>;
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export function grantAllows(
  grant: CapabilityGrant,
  capability: CyberdeckCapability,
  target: { sessionId?: string; cwd?: string } = {},
): boolean {
  const parsed = CapabilityGrantSchema.parse(grant);
  if (!parsed.capabilities.includes(capability)) return false;
  if (parsed.scope.kind === "fleet") return true;
  if (parsed.scope.kind === "self") return target.sessionId === parsed.subjectSessionId;
  return target.cwd !== undefined && target.cwd === parsed.scope.cwd;
}
