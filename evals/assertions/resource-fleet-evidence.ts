import { ResourceCandidateSchema, ResourceFleetEvidenceSchema, type ResourceCandidate, type ResourceFleetEvidence } from "./resource-fleet-schema.js";
export { ResourceCandidateSchema, ResourceFleetEvidenceSchema } from "./resource-fleet-schema.js";
export type { ResourceCandidate, ResourceFleetEvidence } from "./resource-fleet-schema.js";
const BUDGET = 8 * 1024 ** 3;
const ms = (time: string) => Date.parse(time);
const equal = (a: ResourceCandidate, b: ResourceCandidate) => Object.keys(a).every((key) => a[key as keyof ResourceCandidate] === b[key as keyof ResourceCandidate]);
export type ResourceEvidenceAssessment = { status: "failed" | "unverified" | "structurally-consistent";
  failures: string[]; unverified: string[]; breaches: { scope: string; at: string; kind: "observed" | "reservation"; bytes: number }[];
  disclaimer: "Consistency and hashes do not authenticate collection or prove live acceptance." };

export function assessResourceFleetEvidence(raw: unknown, expectedRaw: unknown): ResourceEvidenceAssessment {
  const failures = new Set<string>(), unverified = new Set<string>();
  const breaches: ResourceEvidenceAssessment["breaches"] = [];
  const result = (): ResourceEvidenceAssessment => ({ status: failures.size ? "failed" : unverified.size ? "unverified" : "structurally-consistent",
    failures: [...failures], unverified: [...unverified], breaches,
    disclaimer: "Consistency and hashes do not authenticate collection or prove live acceptance." });
  const parsed = ResourceFleetEvidenceSchema.safeParse(raw), expected = ResourceCandidateSchema.safeParse(expectedRaw);
  if (!parsed.success || !expected.success) { failures.add("schema-invalid"); return result(); }
  const evidence = parsed.data;
  if (evidence.runs.reduce((sum, run) => sum + run.samples.length, evidence.soak?.samples.length ?? 0) > 100000) {
    failures.add("sample-count-limit"); return result();
  }
  if (!equal(evidence.candidate, expected.data)) failures.add("candidate-mismatch");
  const artifacts = new Map(evidence.artifacts.map((artifact) => [artifact.id, artifact]));
  if (artifacts.size !== evidence.artifacts.length || new Set(evidence.artifacts.map((item) => item.file)).size !== evidence.artifacts.length)
    failures.add("duplicate-artifact-identity");
  const ref = (id: string, kind?: ResourceFleetEvidence["artifacts"][number]["kind"]) => {
    const artifact = artifacts.get(id);
    if (!artifact || (kind && artifact.kind !== kind)) unverified.add("missing-or-wrong-evidence-reference");
  };
  const boundary = evidence.boundaries;
  if (boundary.hostMemory === "unknown" || boundary.vmMemory === "unknown" || boundary.unknownAttribution) unverified.add("measurement-boundary-unknown");
  if (boundary.maximumGapMs < boundary.samplingIntervalMs || boundary.maximumGapMs > boundary.samplingIntervalMs * 2) failures.add("sampling-gap-policy-invalid");
  const samples = (rows: ResourceFleetEvidence["runs"][number]["samples"], start: string, finish: string, scope: string) => {
    if (ms(finish) <= ms(start)) failures.add(`${scope}:invalid-duration`);
    if (!rows.length) { unverified.add(`${scope}:samples-missing`); return; }
    let previous = ms(start);
    let first = true;
    for (const row of rows) {
      ref(row.evidenceRef, "sanitized-resource-series");
      const at = ms(row.at);
      if (at < ms(start) || at > ms(finish) || at < previous || (!first && at === previous)) failures.add(`${scope}:sample-time-invalid`);
      if (at - previous > boundary.maximumGapMs) unverified.add(`${scope}:sampling-gap`);
      previous = at; first = false;
      if (!row.attributionComplete || row.managedHostPhysicalBytes === null || row.attributableVmPhysicalBytes === null
        || row.guestCgroupBytes === null || row.samplerPhysicalBytes === null) unverified.add(`${scope}:attribution-or-metric-unknown`);
      if (row.managedHostPhysicalBytes !== null && row.attributableVmPhysicalBytes !== null) {
        const total = row.managedHostPhysicalBytes + row.attributableVmPhysicalBytes;
        if (total > BUDGET) { failures.add(`${scope}:observed-budget-breach`); breaches.push({ scope, at: row.at, kind: "observed", bytes: total }); }
      }
      const reservation = row.admittedReservationsBytes + row.fixedPhysicalBytes + row.uncertaintyReserveBytes + row.controlMarginBytes;
      if (reservation > BUDGET) { failures.add(`${scope}:reservation-budget-breach`); breaches.push({ scope, at: row.at, kind: "reservation", bytes: reservation }); }
      if (row.managedHostPhysicalBytes !== null && row.samplerPhysicalBytes !== null && row.samplerPhysicalBytes > row.managedHostPhysicalBytes)
        failures.add(`${scope}:sampler-outside-host-boundary`);
    }
    if (ms(finish) - previous > boundary.maximumGapMs) unverified.add(`${scope}:sampling-gap`);
  };
  const runIds = new Set<string>(), providers = new Set<string>();
  const warmups = evidence.runs.filter((run) => run.phase === "warmup");
  const measured = evidence.runs.filter((run) => run.phase === "measured");
  if (!warmups.length || measured.length < 3) unverified.add("three-post-warmup-runs-required");
  const chronological = [...evidence.runs].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  if (chronological.some((run, index) => index > 0 && ms(run.startedAt) < ms(chronological[index - 1]!.finishedAt))) failures.add("overlapping-repeated-runs");
  if (new Set(evidence.runs.map((run) => run.barrier.barrierId)).size !== evidence.runs.length) failures.add("duplicate-barrier-id");
  const lastWarmup = Math.max(...warmups.map((run) => ms(run.finishedAt)));
  for (const run of evidence.runs) {
    const scope = run.runId;
    if (runIds.has(scope)) failures.add("duplicate-run-id");
    runIds.add(scope);
    if (!equal(run.candidate, expected.data)) failures.add(`${scope}:candidate-mismatch`);
    if (run.mode !== "live-subscription") unverified.add(`${scope}:not-live-subscription`);
    if (run.phase === "measured" && ms(run.startedAt) < lastWarmup) failures.add(`${scope}:not-after-warmup`);
    if (!run.captureComplete) unverified.add(`${scope}:capture-incomplete`);
    if (run.failures.length || run.workers.some((worker) => worker.outcome === "failed" || worker.outcome === "cancelled")) failures.add(`${scope}:recorded-failure`);
    if (run.cleanupUnexplainedResources > 0) failures.add(`${scope}:cleanup-unexplained`);
    if (run.terminalAttempts < 8 || run.evaluationDispositions !== run.terminalAttempts) unverified.add(`${scope}:outcome-reconciliation-incomplete`);
    if (run.healthRpcP95Ms === null || run.eventLoopP99Ms === null) unverified.add(`${scope}:latency-missing`);
    if ((run.healthRpcP95Ms ?? 0) >= 250 || (run.eventLoopP99Ms ?? 0) >= 100) failures.add(`${scope}:latency-gate`);
    for (const field of ["workerId", "runtimeId", "containerId"] as const)
      if (new Set(run.workers.map((worker) => worker[field])).size !== 8) failures.add(`${scope}:duplicate-${field}`);
    const released = ms(run.barrier.releasedAt);
    ref(run.barrier.evidenceRef, "sanitized-native-events");
    const overlapStart = Math.max(...run.workers.map((worker) => ms(worker.runnableFrom)));
    const overlapEnd = Math.min(...run.workers.map((worker) => ms(worker.runnableUntil)));
    if (released < overlapStart || released >= overlapEnd) failures.add(`${scope}:no-common-runnable-barrier`);
    const progressStarts: number[] = [], progressEnds: number[] = [];
    const eventIds = new Set<string>();
    for (const worker of run.workers) {
      if (run.phase === "measured") providers.add(worker.provider);
      if (worker.authMode !== "subscription") failures.add(`${scope}:non-subscription-auth`);
      if (worker.imageDigest !== expected.data.imageDigest) failures.add(`${scope}:image-mismatch`);
      if (worker.outcome !== "passed") unverified.add(`${scope}:worker-outcome-unverified`);
      ref(worker.outcomeEvidenceRef, "sanitized-summary");
      if (ms(worker.readyAt) > released || ms(worker.readyAt) < ms(run.startedAt)
        || ms(worker.runnableFrom) < ms(run.startedAt) || ms(worker.runnableUntil) > ms(run.finishedAt)
        || ms(worker.runnableFrom) > ms(worker.readyAt)) failures.add(`${scope}:worker-interval-invalid`);
      let previous = -Infinity;
      const commonProgress: number[] = [];
      for (const event of worker.progress) {
        ref(event.evidenceRef, "sanitized-native-events");
        const at = ms(event.at);
        if (eventIds.has(event.eventId)) failures.add(`${scope}:duplicate-native-event`);
        eventIds.add(event.eventId);
        if (event.source !== "provider-native") unverified.add(`${scope}:native-progress-missing`);
        if (at <= previous || at < ms(worker.runnableFrom) || at > ms(worker.runnableUntil)) failures.add(`${scope}:progress-time-invalid`);
        previous = at;
        if (at >= released && at <= overlapEnd) commonProgress.push(at);
      }
      if (commonProgress.length < 2) unverified.add(`${scope}:overlapping-native-progress-missing`);
      else { progressStarts.push(commonProgress[0]!); progressEnds.push(commonProgress.at(-1)!); }
    }
    if (progressStarts.length !== 8 || Math.max(...progressStarts) >= Math.min(...progressEnds)) failures.add(`${scope}:no-common-progress-window`);
    samples(run.samples, run.startedAt, run.finishedAt, scope);
  }
  if (!providers.has("claude") || !providers.has("codex")) unverified.add("provider-coverage-incomplete");
  const soak = evidence.soak;
  if (soak) {
    const scope = "soak";
    if (!equal(soak.candidate, expected.data)) failures.add("soak:candidate-mismatch");
    if (ms(soak.finishedAt) - ms(soak.startedAt) < 24 * 60 * 60 * 1000) failures.add("soak:less-than-24-hours");
    if (ms(soak.warmupFinishedAt) < ms(soak.startedAt) || ms(soak.baseline.at) < ms(soak.warmupFinishedAt)) failures.add("soak:baseline-before-warmup");
    if (soak.cycles.length < 100) unverified.add("soak:100-cycles-required");
    if (soak.failures.length) failures.add("soak:recorded-failure");
    if (!soak.terminalAttempts || soak.terminalAttempts !== soak.evaluationDispositions) unverified.add("soak:outcome-reconciliation-incomplete");
    ref(soak.baseline.evidenceRef, "sanitized-lifecycle");
    const ids = new Set<string>();
    let previous = ms(soak.baseline.at);
    const allowance = Math.max(soak.baseline.memoryBytes * .1, 64 * 1024 ** 2);
    for (const cycle of soak.cycles) {
      ref(cycle.evidenceRef, "sanitized-lifecycle");
      if (ids.has(cycle.cycleId)) failures.add("soak:duplicate-cycle");
      ids.add(cycle.cycleId);
      const times = [cycle.spawnedAt, cycle.settledAt, cycle.parkedAt, cycle.wokeAt, cycle.retiredAt, cycle.observedAt].map(ms);
      if (times[0]! < ms(soak.baseline.at) || times.at(-1)! > ms(soak.finishedAt)
        || times.some((value, i) => i > 0 && value <= times[i - 1]!) || times.at(-1)! <= previous) failures.add("soak:cycle-time-invalid");
      previous = times.at(-1)!;
      if (cycle.phaseId !== soak.baseline.phaseId) unverified.add("soak:non-equivalent-settled-phase");
      if (cycle.memoryBytes === null || cycle.processCount === null || cycle.retainedDiskBytes === null) unverified.add("soak:plateau-metric-unknown");
      if (cycle.memoryBytes !== null && cycle.memoryBytes - soak.baseline.memoryBytes > allowance) failures.add("soak:plateau-growth-breach");
      if (cycle.unexplainedOwnedResources > 0) failures.add("soak:cleanup-unexplained");
    }
    // A positive late-window fitted trend needs a separate noise/retention assessment.
    const late = soak.cycles.slice(Math.floor(soak.cycles.length / 2));
    if (late.length > 1) for (const key of ["memoryBytes", "processCount", "retainedDiskBytes"] as const) {
      const values = late.map((cycle) => cycle[key]);
      if (values.every((value) => value !== null)) {
        const xs = late.map((cycle) => (ms(cycle.observedAt) - ms(late[0]!.observedAt)) / 3600000);
        const meanX = xs.reduce((a, b) => a + b, 0) / xs.length, meanY = values.reduce<number>((a, b) => a + b!, 0) / values.length;
        if (xs.reduce((sum, x, i) => sum + (x - meanX) * (values[i]! - meanY), 0) > 0) unverified.add(`soak:positive-${key}-trend`);
      }
    }
    samples(soak.samples, soak.startedAt, soak.finishedAt, scope);
  }
  return result();
}
