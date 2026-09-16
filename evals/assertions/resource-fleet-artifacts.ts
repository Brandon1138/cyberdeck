import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ResourceFleetEvidenceSchema, type ResourceFleetEvidence } from "./resource-fleet-schema.js";

/** Read a regular file once, capped even if it grows after stat; never follow the final symlink. */
export async function readBoundedEvidenceFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > limit) throw new Error("evidence-file-invalid");
    const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const read = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("evidence-file-changed");
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
};

/** Collector integration helper. Records contain only the strict manifest's sanitized fields. */
export function resourceEvidenceArtifactBodies(evidence: ResourceFleetEvidence): Map<string, unknown> {
  const records = new Map(evidence.artifacts.map((artifact) => [artifact.id, [] as unknown[]]));
  const append = (ref: string, record: unknown) => records.get(ref)?.push(record);
  for (const run of evidence.runs) {
    append(run.barrier.evidenceRef, { type: "barrier", runId: run.runId, ...run.barrier });
    for (const orc of run.orchestrators) append(orc.evidenceRef, { type: "orchestrator-native-runtime", runId: run.runId, ...orc });
    for (const worker of run.workers) {
      const { progress, outcome, outcomeEvidenceRef, ...identity } = worker;
      append(run.barrier.evidenceRef, { type: "worker-ready", runId: run.runId, ...identity });
      for (const event of progress) append(event.evidenceRef, { type: "native-progress", runId: run.runId,
        workerId: worker.workerId, runtimeId: worker.runtimeId, containerId: worker.containerId, generation: worker.generation, ...event });
      append(outcomeEvidenceRef, { type: "worker-outcome", runId: run.runId, workerId: worker.workerId, outcome });
    }
    for (const sample of run.samples) append(sample.evidenceRef, { type: "resource-sample", scope: run.runId, ...sample });
  }
  if (evidence.soak) {
    append(evidence.soak.baseline.evidenceRef, { type: "soak-baseline", ...evidence.soak.baseline });
    for (const cycle of evidence.soak.cycles) append(cycle.evidenceRef, { type: "soak-cycle", ...cycle });
    for (const sample of evidence.soak.samples) append(sample.evidenceRef, { type: "resource-sample", scope: "soak", ...sample });
  }
  return new Map(evidence.artifacts.map((artifact) => [artifact.id,
    { schemaVersion: 1, kind: artifact.kind, records: records.get(artifact.id) }]));
}

export async function verifyResourceFleetArtifacts(raw: unknown, directory: string): Promise<string[]> {
  const parsed = ResourceFleetEvidenceSchema.safeParse(raw);
  if (!parsed.success) return ["artifact-manifest-invalid"];
  const failures: string[] = [];
  const evidence = parsed.data;
  if (evidence.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) > 128 * 1024 ** 2) return ["artifact-total-limit"];
  const root = await realpath(directory);
  const bodies = resourceEvidenceArtifactBodies(evidence);
  for (const artifact of evidence.artifacts) {
    try {
      const data = await readBoundedEvidenceFile(resolve(root, artifact.file), 8 * 1024 ** 2);
      if (data.length !== artifact.bytes || createHash("sha256").update(data).digest("hex") !== artifact.sha256) {
        failures.push(`artifact-hash-or-size-mismatch:${artifact.id}`); continue;
      }
      // Exact sanitized record equality also rejects additional raw transcript/secret fields.
      if (canonical(JSON.parse(data.toString("utf8"))) !== canonical(bodies.get(artifact.id))) failures.push(`artifact-record-mismatch:${artifact.id}`);
    } catch { failures.push(`artifact-unavailable-or-invalid:${artifact.id}`); }
  }
  return failures;
}
