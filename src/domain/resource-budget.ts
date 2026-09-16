import { z } from "zod";

export const CYBERDECK_MEMORY_BYTES = 8 * 1024 ** 3;
const id = z.string().min(1).max(128);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ResourceOwnerSchema = z.object({
  installationId: id, workloadId: id, familyId: id.optional(), executionId: id.optional(),
  generation: z.number().int().positive().optional(),
  kind: z.enum(["control", "orchestrator", "worker", "evaluation", "service"]),
}).strict();
export type ResourceOwner = z.infer<typeof ResourceOwnerSchema>;
export const ResourceDemandSchema = z.object({
  memoryBytes: bytes.positive(), cpuWeight: z.number().int().min(1).max(10000),
  pidLimit: z.number().int().positive().max(65536), profileId: id, profileVersion: id,
}).strict();
export type ResourceDemand = z.infer<typeof ResourceDemandSchema>;
export const ResourceRequestSchema = z.object({
  requestId: id, owner: ResourceOwnerSchema, demand: ResourceDemandSchema,
  priority: z.enum(["interactive", "background"]),
}).strict();
export type ResourceRequest = z.infer<typeof ResourceRequestSchema>;
export type ResourceDecision =
  | { state: "admitted"; reservationId: string; demand: ResourceDemand }
  | { state: "waiting-capacity"; reason: string; queuedAt: string }
  | { state: "resource-infeasible"; reason: string; requiredBytes: number; availableBytes: number };
export interface ResourceAdmissionPort {
  request(input: ResourceRequest): Promise<ResourceDecision>;
  cancel(requestId: string): Promise<void>;
  release(input: { reservationId: string; terminationEvidenceId: string }): Promise<void>;
}
export const ResourceSampleSchema = z.object({
  owner: ResourceOwnerSchema, observedAt: z.iso.datetime(),
  source: z.enum(["macos-process", "docker-cgroup", "vm-host"]),
  memoryBytes: bytes.nullable(), memoryKind: z.enum(["physical-footprint", "rss", "cgroup-current"]),
  cpuCoreFraction: z.number().finite().nonnegative().nullable(), pids: bytes.nullable(),
  uncertainty: z.array(z.string().min(1).max(128)).max(32),
}).strict();
export type ResourceSample = z.infer<typeof ResourceSampleSchema>;

export const ResourcePolicySchema = z.object({
  totalBytes: z.literal(CYBERDECK_MEMORY_BYTES).default(CYBERDECK_MEMORY_BYTES),
  fixedBytes: bytes, uncertainBytes: bytes, controlMarginBytes: bytes,
  maxPids: z.number().int().positive(), maxQueue: z.number().int().min(1).max(10000).default(1024),
  maxBypass: z.number().int().min(0).max(100).default(8),
  maxMetricAgeMs: z.number().int().min(100).max(60000).default(15000),
}).strict().refine(p => p.fixedBytes + p.uncertainBytes + p.controlMarginBytes < p.totalBytes,
  "Fixed overhead and margins must leave runnable capacity");
export type ResourcePolicy = z.infer<typeof ResourcePolicySchema>;
export const ResourceReservationSchema = z.object({
  request: ResourceRequestSchema, sequence: z.number().int().nonnegative(), queuedAt: z.iso.datetime(),
  state: z.enum(["waiting-capacity", "admitted", "cancelled", "released"]),
  reservationId: id, bypasses: z.number().int().nonnegative(),
  terminationEvidenceId: id.optional(),
}).strict();
export type ResourceReservation = z.infer<typeof ResourceReservationSchema>;
export const ResourceLedgerSchema = z.object({
  schemaVersion: z.literal(1), installationId: id, revision: z.number().int().nonnegative(),
  nextSequence: z.number().int().nonnegative(), lastFamily: id.nullable(),
  entries: z.array(ResourceReservationSchema).max(10000),
}).strict();
export type ResourceLedger = z.infer<typeof ResourceLedgerSchema>;
export interface ResourceLedgerPort {
  read(): ResourceLedger;
  /** Compare-and-swap; persists and fsyncs before replacing the visible state. */
  save(next: ResourceLedger, expectedRevision: number): Promise<void>;
}
export interface ResourceEnvironment {
  observedAt: number;
  pressure: "normal" | "elevated" | "critical" | "unknown";
  availableBytes: number | null;
  attributionComplete: boolean;
}
