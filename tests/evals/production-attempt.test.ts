import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { evidenceHash, type EvaluationClaim, type EvaluationEvidenceManifest } from "../../src/persistence/task-evaluation-store.js";
import { parseAttemptReport, PromptfooAttemptRunner } from "../../evals/production/promptfoo-attempt.js";
import { productionRubrics } from "../../evals/production/rubrics.js";
import { PromptfooProcess } from "../../evals/production/evaluate-attempt.js";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const directory = () => { const d = mkdtempSync(join(tmpdir(), "production-eval-")); dirs.push(d); return d; };
function claim(checks: readonly string[], passed = true): EvaluationClaim {
  const manifest: EvaluationEvidenceManifest = { schemaVersion: 1, terminalEvent: { outcome: "succeeded" }, checks: checks.map(id => ({ id, passed, source: "host-verified", artifactHash: "a".repeat(64) })), complete: true, metadata: { modelSource: "unknown" } };
  return { key: "../malicious", token: randomUUID(), expiresAt: 100, manifest, intent: { attemptId: "attempt", sessionId: randomUUID(), generation: 1, attribution: "direct-input", rubricId: "task", rubricVersion: "1", evidenceManifestHash: evidenceHash(manifest) } };
}
const report = (c: EvaluationClaim, pass: boolean) => ({ results: { results: [{ success: pass, gradingResult: { pass }, response: { output: JSON.stringify(c.manifest) } }] } });
test.each(Object.entries(productionRubrics))("%s requires independent ground truth and rejects false pass", (_category, rubric) => {
  const good = claim(rubric.checks), bad = claim(rubric.checks, false);
  expect(parseAttemptReport(report(good, true), good, rubric.checks).disposition).toBe("verified-pass");
  expect(parseAttemptReport(report(bad, false), bad, rubric.checks).disposition).toBe("verified-fail");
  expect(parseAttemptReport(report(bad, true), bad, rubric.checks).disposition).toBe("infrastructure-error");
  expect(parseAttemptReport(report(good, true), good, ["unavailable-ground-truth"]).disposition).toBe("unverified");
});
test("missing/error/mismatched rows cannot pass", () => {
  const c = claim(["tests"]);
  expect(parseAttemptReport({ results: { results: [] } }, c, ["tests"]).disposition).toBe("infrastructure-error");
  expect(parseAttemptReport(report(claim(["fake"]), true), c, ["tests"]).disposition).toBe("unverified");
});
test("hostile retention path and disk cap refused before process launch", async () => {
  const dir = directory(), target = directory(); symlinkSync(target, join(dir, "link"));
  await expect(new PromptfooAttemptRunner({ node: process.execPath, cli: "unused", directory: join(dir, "link"), requiredChecks: ["tests"] }).run(claim(["tests"]))).rejects.toThrow("SYMLINK");
  writeFileSync(join(target, "existing"), "x".repeat(100));
  await expect(new PromptfooAttemptRunner({ node: process.execPath, cli: "unused", directory: target, requiredChecks: ["tests"], maxBytes: 100 }).run(claim(["tests"]))).rejects.toThrow("RETENTION_CAP");
});
test("child output overflow either confirms termination or refuses release on denied group signal", async () => {
  try {
    const result = await new PromptfooProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000))"], directory(), 1000, 128).run(claim(["tests"]));
    expect(result.timedOut).toBe(true); expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(128);
  } catch (error) {
    // Restricted macOS runner denies group signaling, including with escalation. This proves
    // fail-closed release only; it is explicitly not process-group cleanup evidence.
    expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
  }
});
