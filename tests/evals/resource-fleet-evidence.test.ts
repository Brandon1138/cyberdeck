import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessResourceFleetEvidence } from "../../evals/assertions/resource-fleet-evidence.js";
import { resourceEvidenceArtifactBodies, verifyResourceFleetArtifacts, readBoundedEvidenceFile } from "../../evals/assertions/resource-fleet-artifacts.js";
import { resourceFleetFixture, addSoak, at } from "./resource-fleet-fixture.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const assess = (fixture: ReturnType<typeof resourceFleetFixture>) => assessResourceFleetEvidence(fixture, fixture.candidate);

describe("resource fleet acceptance evidence", () => {
  it("recognizes complete structural evidence without claiming authenticated live proof", () => {
    const result = assess(resourceFleetFixture());
    expect(result.status).toBe("structurally-consistent");
    expect(result.disclaimer).toContain("do not authenticate");
  });
  it("rejects eight rows backed by only two runtimes and containers", () => {
    const fixture = resourceFleetFixture();
    fixture.runs[1]!.workers.forEach((worker, i) => { worker.runtimeId = `runtime-${i % 2}`; worker.containerId = String(i % 2).repeat(64); });
    expect(assess(fixture).failures).toEqual(expect.arrayContaining(["run-1:duplicate-runtimeId", "run-1:duplicate-containerId"]));
  });
  it("rejects sequential native progress despite claimed overlapping runnable intervals", () => {
    const fixture = resourceFleetFixture();
    fixture.runs[1]!.workers.forEach((worker, i) => { worker.progress[0]!.at = at(12000 + i * 400); worker.progress[1]!.at = at(12100 + i * 400); });
    expect(assess(fixture).failures).toContain("run-1:no-common-progress-window");
  });
  it("rejects a barrier released before every worker is runnable or ready", () => {
    const fixture = resourceFleetFixture(); fixture.runs[1]!.workers[7]!.readyAt = at(12000);
    expect(assess(fixture).failures).toContain("run-1:worker-interval-invalid");
  });
  it("cannot pass missing samples, gaps, unknown attribution or incomplete capture", () => {
    const fixture = resourceFleetFixture(); fixture.runs[1]!.samples = [];
    fixture.runs[2]!.samples.splice(1, 4); fixture.runs[3]!.samples[0]!.attributionComplete = false;
    fixture.runs[0]!.captureComplete = false;
    expect(assess(fixture).status).toBe("unverified");
    expect(assess(fixture).unverified).toEqual(expect.arrayContaining(["run-1:samples-missing", "run-2:sampling-gap", "run-3:attribution-or-metric-unknown"]));
  });
  it("reports every breach; guests and configured maxima are not added to physical totals", () => {
    const fixture = resourceFleetFixture();
    fixture.runs[1]!.samples[2]!.managedHostPhysicalBytes = 8 * 1024 ** 3;
    fixture.runs[1]!.samples[3]!.managedHostPhysicalBytes = 8 * 1024 ** 3;
    fixture.runs[1]!.samples[4]!.admittedReservationsBytes = 8 * 1024 ** 3;
    expect(assess(fixture).breaches).toHaveLength(3);
    expect(assess(resourceFleetFixture()).breaches).toEqual([]);
  });
  it("rejects the wrong exact source, dirty flag, profile, config, or image", () => {
    const fixture = resourceFleetFixture();
    for (const key of Object.keys(fixture.candidate) as (keyof typeof fixture.candidate)[]) {
      const expected = { ...fixture.candidate, [key]: key === "dirty" ? true : key === "sourceSha" ? "f".repeat(40) : key === "imageDigest" ? `sha256:${"f".repeat(64)}` : "f".repeat(64) };
      expect(assessResourceFleetEvidence(fixture, expected).failures).toContain("candidate-mismatch");
    }
  });
  it("requires warmup, three measured runs, both providers, subscription auth and native events", () => {
    const fixture = resourceFleetFixture(); fixture.runs.shift(); fixture.runs.pop();
    fixture.runs.forEach((run) => run.workers.forEach((worker) => { worker.provider = "claude"; }));
    fixture.runs[0]!.workers[0]!.authMode = "api";
    fixture.runs[0]!.workers[1]!.progress[0]!.source = "scripted";
    const result = assess(fixture);
    expect(result.unverified).toEqual(expect.arrayContaining(["three-post-warmup-runs-required", "provider-coverage-incomplete", "run-1:native-progress-missing"]));
    expect(result.failures).toContain("run-1:non-subscription-auth");
  });
  it("retains failed runs and rejects missing outcomes or failed responsiveness", () => {
    const fixture = resourceFleetFixture(); fixture.runs[1]!.failures.push("oom"); fixture.runs[2]!.evaluationDispositions = 7; fixture.runs[3]!.healthRpcP95Ms = 250;
    const result = assess(fixture);
    expect(result.failures).toEqual(expect.arrayContaining(["run-1:recorded-failure", "run-3:latency-gate"]));
    expect(result.unverified).toContain("run-2:outcome-reconciliation-incomplete");
  });
  it("requires an actual 24-hour sampled soak and 100 equivalent completed cycles", () => {
    const fixture = resourceFleetFixture(); addSoak(fixture);
    expect(assess(fixture).status).toBe("structurally-consistent");
    fixture.soak!.finishedAt = at(3600000); fixture.soak!.cycles.pop();
    const result = assess(fixture);
    expect(result.failures).toContain("soak:less-than-24-hours");
    expect(result.unverified).toContain("soak:100-cycles-required");
  });
  it("fails plateau excess and leaves positive late trends unverified", () => {
    const fixture = resourceFleetFixture(); addSoak(fixture);
    fixture.soak!.cycles.forEach((cycle, i) => { cycle.memoryBytes! += i * 2000000; });
    const result = assess(fixture);
    expect(result.failures).toContain("soak:plateau-growth-breach");
    expect(result.unverified).toContain("soak:positive-memoryBytes-trend");
  });
  it("checks bounded files, hashes and exact sanitized records, rejecting symlinks and added fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "resource-evidence-")); directories.push(directory);
    const fixture = resourceFleetFixture();
    const bodies = resourceEvidenceArtifactBodies(fixture);
    for (const artifact of fixture.artifacts) {
      const data = JSON.stringify(bodies.get(artifact.id)); artifact.bytes = Buffer.byteLength(data); artifact.sha256 = createHash("sha256").update(data).digest("hex");
      await writeFile(join(directory, artifact.file), data);
    }
    expect(await verifyResourceFleetArtifacts(fixture, directory)).toEqual([]);
    await writeFile(join(directory, "manifest.json"), JSON.stringify(fixture));
    await writeFile(join(directory, "expected.json"), JSON.stringify(fixture.candidate));
    const cli = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/verify-resource-evidence.ts", join(directory, "manifest.json"), join(directory, "expected.json")], { timeout: 5000, maxBuffer: 65536 });
    expect(JSON.parse(cli.stdout).status).toBe("evidence-consistent");
    const savedHash = fixture.artifacts[0]!.sha256;
    fixture.artifacts[0]!.sha256 = "f".repeat(64);
    expect(await verifyResourceFleetArtifacts(fixture, directory)).toContain("artifact-hash-or-size-mismatch:native");
    fixture.artifacts[0]!.sha256 = savedHash;
    const artifact = fixture.artifacts[0]!;
    const extra = JSON.stringify({ ...(bodies.get(artifact.id) as object), rawTranscript: "private" });
    artifact.bytes = Buffer.byteLength(extra); artifact.sha256 = createHash("sha256").update(extra).digest("hex");
    await writeFile(join(directory, artifact.file), extra);
    expect(await verifyResourceFleetArtifacts(fixture, directory)).toContain("artifact-record-mismatch:native");
    await symlink(join(directory, artifact.file), join(directory, "link.json"));
    await expect(readBoundedEvidenceFile(join(directory, "link.json"), 100000)).rejects.toThrow();
    await expect(readBoundedEvidenceFile(join(directory, artifact.file), 1)).rejects.toThrow();
    fixture.artifacts[0]!.file = "../escape.json";
    expect(assess(fixture).failures).toContain("schema-invalid");
  });
});
