import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { hardFailures, suiteFailures } from "../../evals/assertions/invariants.js";
import { scenarioChecks, scenarioIds, containerChecks, requiredChecks, type ScenarioId } from "../../evals/scenarios/catalog.js";
import { LiveEvalConfigSchema, loadLiveEvalConfig } from "../../evals/harness/live-config.js";
import type { ScenarioEvidence } from "../../evals/assertions/evidence.js";
import { verifyEvidenceArtifacts } from "../../evals/assertions/artifacts.js";

function evidence(id: ScenarioId = "dirty-tree-false-completion", mode: ScenarioEvidence["mode"] = "offline-scripted"): ScenarioEvidence {
  const live = mode === "live-container";
  return { schemaVersion: 1, runId: randomUUID(), brokerId: randomUUID(), scenarioId: id, scenarioVersion: 1,
    mode, status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    commit: "a".repeat(40), dirtyImplementation: false, provider: live ? "claude" : "scripted", providerVersion: "fixture-v1", model: live ? "fixture-model" : "scripted-fixture",
    ...(mode === "offline-scripted" ? {} : { image: `sha256:${"c".repeat(64)}` }),
    captureComplete: true, requiredCommandCoverage: true, commandCoverage: live ? "provider-native" : "scripted", expectedChangedPaths: ["answer.txt"], actualChangedPaths: ["answer.txt"], reportedChangedPaths: ["answer.txt"],
    unrelatedPathsChanged: [], unauthorizedMutationCount: 0, missingInstructionIds: [], harnessErrors: [], cleanup: "complete",
    artifacts: [{ id: "facts", path: "/fixture/facts.json", sha256: "b".repeat(64) }],
    checks: requiredChecks(id, mode).map((name) => ({ name, passed: true, provenance: name === "other-worker-unavailable" ? "host-verified" : "scripted", evidenceRefs: ["facts"] })),
    spend: { measuredUsd: null, authorizedCeilingUsd: live ? 5 : null },
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
    const full = scenarioIds.map((id) => evidence(id));
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
  it.each(scenarioIds)("requires the container-only checks of %s in both container modes and never offline", (id) => {
    for (const mode of ["container-scripted", "live-container"] as const) {
      const valid = evidence(id, mode);
      expect(hardFailures(valid)).toEqual([]);
      for (const name of containerChecks[id] ?? []) {
        expect(hardFailures({ ...valid, checks: valid.checks.filter((check) => check.name !== name) })).toContain(`check:${name}`);
        expect(hardFailures({ ...valid, checks: valid.checks.map((check) => check.name === name ? { ...check, passed: false } : check) })).toContain(`check:${name}`);
      }
      expect(hardFailures({ ...valid, image: undefined })).toContain("container-evidence-invalid");
    }
    expect(requiredChecks(id, "offline-scripted")).toEqual(scenarioChecks[id]);
  });
  it("refuses a scripted guest relabelled live, a guest-only isolation claim, and a live suite short of its repetitions", () => {
    const scripted = { ...evidence("cross-worker", "container-scripted"), mode: "live-container" as const };
    expect(hardFailures(scripted)).toContain("live-evidence-invalid");
    const guestOnly = evidence("cross-worker", "container-scripted");
    guestOnly.checks = guestOnly.checks.map((check) => check.name === "other-worker-unavailable" ? { ...check, provenance: "provider-native" as const } : check);
    expect(hardFailures(guestOnly)).toContain("guest-isolation-evidence-missing");
    const live = scenarioIds.flatMap((id) => [evidence(id, "live-container"), evidence(id, "live-container")]);
    expect(suiteFailures(live, "live-container", 3)).toEqual(scenarioIds.map((id) => `suite-count:${id}`));
    expect(suiteFailures([...live, ...scenarioIds.map((id) => evidence(id, "live-container"))], "live-container", 3)).toEqual([]);
    expect(suiteFailures(scenarioIds.map((id) => evidence(id, "container-scripted")), "live-container", 1)).not.toEqual([]);
  });
  it("never runs live without the operator's config file and validates every value in it", async () => {
    await expect(loadLiveEvalConfig(undefined)).rejects.toThrow("LIVE_EVAL_REQUIRES_AUTHORIZED_CONFIG_AND_NATIVE_CAPTURE");
    const base = { provider: "claude", model: "fixture-model", credentialFile: "/tmp/key", authorizedCeilingUsd: 5 };
    expect(LiveEvalConfigSchema.parse(base)).toMatchObject({ repetitions: 3, cpus: 2, attemptTimeoutMinutes: 30 });
    expect(LiveEvalConfigSchema.safeParse({ ...base, authorizedCeilingUsd: 0 }).success).toBe(false);
    expect(LiveEvalConfigSchema.safeParse({ ...base, credentialFile: "relative/key" }).success).toBe(false);
    expect(LiveEvalConfigSchema.safeParse({ ...base, provider: "cursor" }).success).toBe(false);
    expect(LiveEvalConfigSchema.safeParse({ ...base, judgeModel: "anything" }).success).toBe(false);
  });
});
