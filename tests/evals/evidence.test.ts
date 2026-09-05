import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { hardFailures, suiteFailures } from "../../evals/assertions/invariants.js";
import { scenarioChecks, scenarioIds, type ScenarioId } from "../../evals/scenarios/catalog.js";
import type { ScenarioEvidence } from "../../evals/assertions/evidence.js";
import { verifyEvidenceArtifacts } from "../../evals/assertions/artifacts.js";

function evidence(id: ScenarioId = "dirty-tree-false-completion"): ScenarioEvidence {
  return { schemaVersion: 1, runId: randomUUID(), brokerId: randomUUID(), scenarioId: id, scenarioVersion: 1,
    mode: "offline-scripted", status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    commit: "a".repeat(40), dirtyImplementation: false, provider: "scripted", providerVersion: "fixture-v1", model: "scripted-fixture",
    captureComplete: true, requiredCommandCoverage: true, commandCoverage: "scripted", expectedChangedPaths: ["answer.txt"], actualChangedPaths: ["answer.txt"], reportedChangedPaths: ["answer.txt"],
    unrelatedPathsChanged: [], unauthorizedMutationCount: 0, missingInstructionIds: [], harnessErrors: [], cleanup: "complete",
    artifacts: [{ id: "facts", path: "/fixture/facts.json", sha256: "b".repeat(64) }],
    checks: scenarioChecks[id].map((name) => ({ name, passed: true, provenance: "scripted", evidenceRefs: ["facts"] })),
    spend: { measuredUsd: null, authorizedCeilingUsd: null },
  };
}
describe("evidence requirements", () => {
  it("rejects false completion claims independently from actual filesystem effects", () => {
    expect(hardFailures(evidence())).toEqual([]);
    expect(hardFailures({ ...evidence(), reportedChangedPaths: [] })).toContain("false-completion-report");
    expect(hardFailures({ ...evidence(), actualChangedPaths: [] })).toContain("expected-changes-mismatch");
    expect(hardFailures({ ...evidence(), unrelatedPathsChanged: ["notes.txt"] })).toContain("unrelated-work-modified");
  });
  it("fails missing capture, command evidence, artifacts, and harness errors", () => {
    expect(hardFailures({ ...evidence(), captureComplete: false })).toContain("required-evidence-missing");
    expect(hardFailures({ ...evidence(), commandCoverage: "unavailable" })).toContain("command-evidence-missing");
    expect(hardFailures({ ...evidence(), artifacts: [] })).toContain("evidence-schema-invalid");
    expect(hardFailures({ ...evidence(), harnessErrors: ["broken"] })).toContain("harness:broken");
  });
  it.each(scenarioIds)("detects every deliberately failed or omitted critical check in %s", (id) => {
    const valid = evidence(id);
    for (let i = 0; i < valid.checks.length; i++) {
      const failed = structuredClone(valid); failed.checks[i]!.passed = false;
      expect(hardFailures(failed)).toContain(`check:${valid.checks[i]!.name}`);
      const missing = structuredClone(valid); missing.checks.splice(i, 1);
      expect(hardFailures(missing)).toContain(`check:${valid.checks[i]!.name}`);
    }
  });
  it("rejects empty, skipped, duplicate and incomplete suites and relabelled scripted runs", () => {
    expect(suiteFailures([], "offline-scripted", 1)).toHaveLength(scenarioIds.length);
    const full = scenarioIds.map(evidence);
    expect(suiteFailures(full, "offline-scripted", 1)).toEqual([]);
    expect(suiteFailures(full.slice(1), "offline-scripted", 1)).not.toEqual([]);
    expect(suiteFailures([...full, full[0]], "offline-scripted", 1)).toContain("duplicate-run");
    expect(hardFailures({ ...evidence(), mode: "live-container" })).toContain("live-evidence-invalid");
  });
  it("rejects changed or missing evidence files after a completed evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "eval-artifact-")), path = join(root, "facts.json");
    try {
      const report = evidence(), body = '{"verified":true}';
      await writeFile(path, body);
      report.artifacts = [{ id: "facts", path, sha256: createHash("sha256").update(body).digest("hex") }];
      expect(await verifyEvidenceArtifacts(report)).toEqual([]);
      await writeFile(path, '{"verified":false}');
      expect(await verifyEvidenceArtifacts(report)).toContain("artifact-hash-mismatch");
      await rm(path);
      expect(await verifyEvidenceArtifacts(report)).toContain("artifact-unavailable");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
