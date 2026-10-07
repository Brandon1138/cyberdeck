import { z } from "zod";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const time = z.iso.datetime();
export const ResourceCandidateSchema = z.object({
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean(),
  profileSha256: hash, configSha256: hash, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type ResourceCandidate = z.infer<typeof ResourceCandidateSchema>;
const Artifact = z.object({ id, file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  sha256: hash, bytes: bytes.max(8 * 1024 ** 2), kind: z.enum(["sanitized-native-events", "sanitized-resource-series", "sanitized-lifecycle", "sanitized-summary"]),
}).strict();
const Sample = z.object({ at: time, managedHostPhysicalBytes: bytes.nullable(), attributableVmPhysicalBytes: bytes.nullable(),
  guestCgroupBytes: bytes.nullable(), admittedReservationsBytes: bytes, configuredMaxBytes: bytes,
  fixedPhysicalBytes: bytes, uncertaintyReserveBytes: bytes, controlMarginBytes: bytes,
  samplerPhysicalBytes: bytes.nullable(), attributionComplete: z.boolean(), evidenceRef: id,
}).strict();
const Worker = z.object({ workerId: id, runtimeId: id, containerId: hash, generation: z.number().int().positive(),
  provider: z.enum(["claude", "codex"]), providerVersion: id, model: id, effort: id,
  authMode: z.enum(["subscription", "api", "unknown"]), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  readyAt: time, runnableFrom: time, runnableUntil: time,
  progress: z.array(z.object({ at: time, eventId: id, source: z.enum(["provider-native", "scripted", "unknown"]), evidenceRef: id }).strict()).min(2).max(10000),
  outcome: z.enum(["passed", "failed", "cancelled", "unknown"]), outcomeEvidenceRef: id,
}).strict();
const Orc = z.object({ runtimeId: id, sessionId: id, pid: z.number().int().positive(),
  birthIdentity: z.string().regex(/^libproc:\d+\.\d{6}$/),
  provider: z.literal("codex"), runtime: z.literal("first-party-codex"),
  authMode: z.enum(["subscription", "api", "unknown"]), providerVersion: id, model: id, effort: id,
  readyAt: time, runnableFrom: time, runnableUntil: time, evidenceRef: id,
}).strict();
const Run = z.object({ runId: id, phase: z.enum(["warmup", "measured"]), candidate: ResourceCandidateSchema,
  mode: z.enum(["live-subscription", "scripted", "unknown"]), startedAt: time, finishedAt: time,
  barrier: z.object({ barrierId: id, releasedAt: time, evidenceRef: id }).strict(),
  orchestrators: z.array(Orc).length(1), workers: z.array(Worker).length(8), samples: z.array(Sample).max(100000),
  healthRpcP95Ms: z.number().finite().nonnegative().nullable(), eventLoopP99Ms: z.number().finite().nonnegative().nullable(),
  captureComplete: z.boolean(), cleanupUnexplainedResources: z.number().int().nonnegative(),
  terminalAttempts: z.number().int().nonnegative(), evaluationDispositions: z.number().int().nonnegative(),
  failures: z.array(id).max(128),
}).strict();
const Cycle = z.object({ cycleId: id, phaseId: id, spawnedAt: time, settledAt: time, parkedAt: time, wokeAt: time,
  retiredAt: time, observedAt: time, memoryBytes: bytes.nullable(), processCount: bytes.nullable(), retainedDiskBytes: bytes.nullable(),
  unexplainedOwnedResources: bytes, evidenceRef: id,
}).strict();
export const ResourceFleetEvidenceSchema = z.object({ schemaVersion: z.literal(1), candidate: ResourceCandidateSchema,
  host: z.object({ hardware: id, os: id, node: id, pnpm: id }).strict(),
  boundaries: z.object({ hostMemory: z.enum(["physical-footprint-includes-sampler-excludes-vm", "unknown"]),
    vmMemory: z.enum(["attributed-physical-includes-guests", "unknown"]), guestMemory: z.literal("cgroup-current-diagnostic-only"),
    reservationMemory: z.literal("runnable-envelopes-not-usage"), configuredMemory: z.literal("maxima-not-usage"),
    unknownAttribution: z.boolean(), samplingIntervalMs: z.number().int().min(100).max(15000),
    maximumGapMs: z.number().int().min(100).max(30000),
  }).strict(), artifacts: z.array(Artifact).min(1).max(64), runs: z.array(Run).min(1).max(64),
  soak: z.object({ claimed: z.literal(true), candidate: ResourceCandidateSchema, startedAt: time, finishedAt: time,
    warmupFinishedAt: time, baseline: z.object({ at: time, phaseId: id, memoryBytes: bytes, processCount: bytes, retainedDiskBytes: bytes, evidenceRef: id }).strict(),
    samples: z.array(Sample).max(100000), cycles: z.array(Cycle).max(10000),
    terminalAttempts: bytes, evaluationDispositions: bytes, failures: z.array(id).max(128),
  }).strict().optional(),
}).strict();
export type ResourceFleetEvidence = z.infer<typeof ResourceFleetEvidenceSchema>;
