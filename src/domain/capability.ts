import { z } from "zod";

export const CyberdeckCapabilitySchema = z.enum([
  "thread.list",
  "thread.read",
  "thread.enqueue",
  "worker.start",
  "workflow.run",
]);

export const CapabilityGrantSchema = z.object({
  subjectSessionId: z.uuid(),
  capabilities: z.array(CyberdeckCapabilitySchema),
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

