import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { SessionRecord } from "./session.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const LegacyRetirementRequestSchema = z.object({
  sessionId: z.uuid(), generation: z.number().int().positive(), pid: z.number().int().min(2),
  transitionId: z.string().min(1), expectedRevision: z.number().int().nonnegative(),
  recordSha256: digest, mutationId: z.string().min(1),
  confirmHostPtyProvenance: z.literal(true), provenance: z.string().trim().min(20).max(4096),
  managedHome: z.string().refine(isAbsolute), confirmManagedDaemonProvenance: z.literal(true),
}).strict();
export const LegacyRetirementProofSchema = z.object({
  observedAt: z.iso.datetime(), homeDirectory: z.string().min(1), socketPath: z.string().min(1),
  daemonIdentitySha256: digest, daemonPid: z.number().int().min(2),
  kind: z.literal("host-group-absent-and-managed-daemon-empty"),
}).strict();
export const LegacyRetirementReceiptSchema = z.object({
  request: LegacyRetirementRequestSchema, requestHash: digest, proof: LegacyRetirementProofSchema,
  contract: z.literal("operator-audited-node-pty-setsid"),
}).strict();
export type LegacyRetirementRequest = z.infer<typeof LegacyRetirementRequestSchema>;
export type LegacyRetirementProof = z.infer<typeof LegacyRetirementProofSchema>;
export type LegacyRetirementReceipt = z.infer<typeof LegacyRetirementReceiptSchema>;
export const legacyRetirementHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const legacyRetirementFingerprint = (r: SessionRecord) => legacyRetirementHash({
  id: r.id, generation: r.generation, pid: r.pid, createdAt: r.createdAt, executor: r.executor,
  provider: r.provider, kind: r.kind, codexActorMarker: r.codexActorMarker, launchRecord: r.launchRecord,
});

/** Eligibility is deliberately narrower than an ordinary unknown-exit host record. */
export function isLegacyHostPty(r: SessionRecord): boolean {
  const launch = r.launchRecord, args = launch?.args ?? [];
  return r.provider === "codex" && r.kind === "orchestrator" && r.executor === "host"
    && r.codexActorMarker === true && r.recoveryProcessGroup === undefined && r.exitCode === -1
    && ["cancelled", "exited", "failed"].includes(r.executionState) && r.pid > 1
    && launch?.mode === "launch" && launch.transport === "pty"
    && args[0]?.endsWith("/providers/codex/remote-mcp-launch.js") === true
    && args[1] === "--actor-session" && args[2] === r.id
    && args.some((arg, i) => arg === "--remote" && args[i + 1] === "unix://");
}
export function legacyRetirementMatches(receipt: LegacyRetirementReceipt, record: SessionRecord): boolean {
  return isLegacyHostPty(record) && receipt.request.sessionId === record.id
    && receipt.request.generation === record.generation && receipt.request.pid === record.pid
    && receipt.request.recordSha256 === legacyRetirementFingerprint(record)
    && receipt.requestHash === legacyRetirementHash(receipt.request);
}
