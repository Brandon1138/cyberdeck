import { z } from "zod";
import type { TaskEvaluationResult } from "../../domain/task-evaluation.js";
import { evidenceHash, type EvaluationClaim } from "../../persistence/task-evaluation-store.js";

/** Independent checks consume host evidence; worker prose has no grading authority. */
export function evaluateEvidence(claim: EvaluationClaim, requiredChecks: readonly string[] = []): TaskEvaluationResult {
  const manifest = claim.manifest;
  if (evidenceHash(manifest) !== claim.intent.evidenceManifestHash) return { disposition: "unverified", reason: "evidence-hash-mismatch" };
  const event = manifest.terminalEvent as { outcome?: string; kind?: string };
  if (event.outcome === "cancelled" || event.kind === "instruction.cancelled") return { disposition: "cancelled", reason: "canonical-cancellation" };
  if (event.kind === "execution.lifecycle" && event.outcome === "failed") return { disposition: "infrastructure-error", reason: "execution-failed" };
  if (event.kind === "profile.settled" && event.outcome === "unknown") return { disposition: "infrastructure-error", reason: "profile-infrastructure-failure" };
  if (event.kind === "job.settled" && event.outcome === "unknown") return { disposition: "infrastructure-error", reason: "job-interrupted" };
  if (event.kind === "launch.settled") return event.outcome === "failed"
    ? { disposition: "infrastructure-error", reason: "launch-failed-before-provider" }
    : { disposition: "unverified", reason: "launch-boundary-uncertain" };
  if (!manifest.complete || !requiredChecks.length || requiredChecks.some(id => manifest.checks.filter(c => c.id === id).length !== 1)) return { disposition: "unverified", reason: "missing-independent-evidence" };
  if (manifest.checks.some(c => c.source !== "host-verified" || !/^[a-f0-9]{64}$/.test(c.artifactHash))) return { disposition: "unverified", reason: "untrusted-check" };
  return { disposition: manifest.checks.filter(c => requiredChecks.includes(c.id)).every(c => c.passed) ? "verified-pass" : "verified-fail", reason: "independent-host-checks" };
}

const Report = z.object({ results: z.object({ results: z.array(z.object({
  success: z.boolean(), error: z.unknown().optional(), response: z.object({ output: z.string() }),
  gradingResult: z.object({ pass: z.boolean() }),
})).length(1) }) });
export function parseAttemptReport(raw: unknown, claim: EvaluationClaim, checks: readonly string[]): TaskEvaluationResult {
  const parsed = Report.safeParse(raw);
  if (!parsed.success) return { disposition: "infrastructure-error", reason: "promptfoo-report-invalid" };
  const row = parsed.data.results.results[0]!;
  if (row.error !== undefined && row.error !== null) return { disposition: "infrastructure-error", reason: "promptfoo-row-error" };
  if (row.response.output !== JSON.stringify(claim.manifest)) return { disposition: "unverified", reason: "promptfoo-evidence-mismatch" };
  const independent = evaluateEvidence(claim, checks);
  if (independent.disposition === "verified-pass" && (!row.success || !row.gradingResult.pass)) return { disposition: "infrastructure-error", reason: "promptfoo-grader-disagreement" };
  if (independent.disposition === "verified-fail" && (row.success || row.gradingResult.pass)) return { disposition: "infrastructure-error", reason: "promptfoo-grader-disagreement" };
  return independent;
}
