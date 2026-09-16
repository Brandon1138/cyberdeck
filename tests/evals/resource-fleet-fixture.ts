import type { ResourceFleetEvidence } from "../../evals/assertions/resource-fleet-evidence.js";
export const at = (offset: number) => new Date(Date.UTC(2026, 8, 16) + offset).toISOString();
export function resourceFleetFixture(): ResourceFleetEvidence {
  const candidate = { sourceSha: "a".repeat(40), dirty: false, profileSha256: "b".repeat(64), configSha256: "c".repeat(64), imageDigest: `sha256:${"d".repeat(64)}` };
  const artifact = (id: string, kind: ResourceFleetEvidence["artifacts"][number]["kind"]) => ({ id, kind, file: `${id}.json`, sha256: "0".repeat(64), bytes: 0 });
  const evidence: ResourceFleetEvidence = { schemaVersion: 1, candidate, host: { hardware: "macbook-arm64", os: "27.0", node: "24.18.0", pnpm: "11.5.0" },
    boundaries: { hostMemory: "physical-footprint-includes-sampler-excludes-vm", vmMemory: "attributed-physical-includes-guests",
      guestMemory: "cgroup-current-diagnostic-only", reservationMemory: "runnable-envelopes-not-usage", configuredMemory: "maxima-not-usage",
      unknownAttribution: false, samplingIntervalMs: 1000, maximumGapMs: 2000 },
    artifacts: [artifact("native", "sanitized-native-events"), artifact("resources", "sanitized-resource-series"), artifact("outcomes", "sanitized-summary")], runs: [] };
  for (let n = 0; n < 4; n++) {
    const start = n * 10000;
    evidence.runs.push({ runId: `run-${n}`, phase: n === 0 ? "warmup" : "measured", candidate: { ...candidate }, mode: "live-subscription",
      startedAt: at(start), finishedAt: at(start + 6000), barrier: { barrierId: `barrier-${n}`, releasedAt: at(start + 1500), evidenceRef: "native" },
      workers: Array.from({ length: 8 }, (_, i) => ({ workerId: `worker-${i}`, runtimeId: `runtime-${n}-${i}`, containerId: (i + 1).toString().repeat(64), generation: 1,
        provider: i % 2 ? "codex" : "claude", providerVersion: "1.0", model: "fixture-model", effort: "low", authMode: "subscription", imageDigest: candidate.imageDigest,
        readyAt: at(start + 1000), runnableFrom: at(start + 500), runnableUntil: at(start + 5500),
        progress: [2000 + i * 10, 4000 + i * 10].map((time, index) => ({ at: at(start + time), eventId: `event-${i}-${index}`, source: "provider-native", evidenceRef: "native" })),
        outcome: "passed", outcomeEvidenceRef: "outcomes" })),
      samples: Array.from({ length: 7 }, (_, i) => resourceSample(start + i * 1000)),
      healthRpcP95Ms: 10, eventLoopP99Ms: 5, captureComplete: true, cleanupUnexplainedResources: 0,
      terminalAttempts: 8, evaluationDispositions: 8, failures: [] });
  }
  return evidence;
}
export function resourceSample(offset: number): ResourceFleetEvidence["runs"][number]["samples"][number] {
  return { at: at(offset), managedHostPhysicalBytes: 1024 ** 3, attributableVmPhysicalBytes: 1024 ** 3,
    guestCgroupBytes: 1024 ** 3, admittedReservationsBytes: 1024 ** 3, configuredMaxBytes: 16 * 1024 ** 3,
    fixedPhysicalBytes: 1024 ** 3, uncertaintyReserveBytes: 100, controlMarginBytes: 100,
    samplerPhysicalBytes: 100, attributionComplete: true, evidenceRef: "resources" };
}
export function addSoak(evidence: ResourceFleetEvidence): void {
  evidence.artifacts.push({ id: "lifecycle", kind: "sanitized-lifecycle", file: "lifecycle.json", sha256: "0".repeat(64), bytes: 0 });
  evidence.boundaries.samplingIntervalMs = 15000; evidence.boundaries.maximumGapMs = 30000;
  evidence.soak = { claimed: true, candidate: { ...evidence.candidate }, startedAt: at(0), finishedAt: at(86400000), warmupFinishedAt: at(1000),
    baseline: { at: at(2000), phaseId: "settled", memoryBytes: 1024 ** 3, processCount: 2, retainedDiskBytes: 100, evidenceRef: "lifecycle" },
    cycles: Array.from({ length: 100 }, (_, i) => ({ cycleId: `cycle-${i}`, phaseId: "settled", spawnedAt: at(3000 + i * 600000), settledAt: at(3001 + i * 600000),
      parkedAt: at(3002 + i * 600000), wokeAt: at(3003 + i * 600000), retiredAt: at(3004 + i * 600000), observedAt: at(3005 + i * 600000),
      memoryBytes: 1024 ** 3, processCount: 2, retainedDiskBytes: 100, unexplainedOwnedResources: 0, evidenceRef: "lifecycle" })),
    samples: Array.from({ length: 5761 }, (_, i) => resourceSample(i * 15000)), terminalAttempts: 100, evaluationDispositions: 100, failures: [] };
}
