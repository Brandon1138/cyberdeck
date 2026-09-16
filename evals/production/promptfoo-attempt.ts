import { constants } from "node:fs";
import { open, mkdir, readdir, lstat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { writeAtomicPrivateFile } from "../../src/persistence/atomic-private-file.js";
import type { EvaluationClaim } from "../../src/persistence/task-evaluation-store.js";
import { evaluateEvidence, PromptfooProcess, type EvaluationProcessPort, type EvaluationProcessResult } from "./evaluate-attempt.js";
import type { TaskEvaluationResult } from "../../src/domain/task-evaluation.js";

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

/** One supervisor owns the report directory; maxBytes includes retained reports/configs.
 * Content-derived filenames contain no worker-provided path. No API provider or judge is used. */
export class PromptfooAttemptRunner implements EvaluationProcessPort {
  constructor(private readonly options: { node: string; cli: string; directory: string; requiredChecks: readonly string[];
    maxBytes?: number; maxReportBytes?: number; timeoutMs?: number }) {}
  async run(claim: EvaluationClaim): Promise<EvaluationProcessResult> {
    const directory = resolve(this.options.directory), maxBytes = this.options.maxBytes ?? 16 * 1024 ** 2;
    const reportCap = this.options.maxReportBytes ?? 1024 * 1024;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("PROMPTFOO_DIRECTORY_SYMLINK");
    const files = await readdir(directory);
    if (files.length > 4096) throw new Error("PROMPTFOO_RETENTION_CAP");
    let bytes = 0;
    for (const file of files) { const stat = await lstat(join(directory, file)); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("PROMPTFOO_RETENTION_UNSAFE"); bytes += stat.size; }
    const prefix = createHash("sha256").update(`${claim.key}:${claim.token}`).digest("hex");
    const provider = join(directory, `${prefix}.cjs`), config = join(directory, `${prefix}.json`), report = join(directory, `${prefix}.report.json`);
    const body = JSON.stringify({ description: `cyberdeck-production:${claim.intent.rubricId}:${claim.intent.rubricVersion}`,
      prompts: ["{{evidence}}"], providers: [`file://${provider}`], evaluateOptions: { maxConcurrency: 1, cache: false },
      tests: [{ vars: { evidence: JSON.stringify(claim.manifest) }, assert: [{ type: "javascript", value:
        `const m=JSON.parse(output); const required=${JSON.stringify(this.options.requiredChecks)}; return m.complete && required.length>0 && required.every(id=>m.checks.filter(c=>c.id===id&&c.source==='host-verified'&&c.passed===true).length===1);` }] }] });
    if (bytes + Buffer.byteLength(body) + reportCap + 4096 > maxBytes) throw new Error("PROMPTFOO_RETENTION_CAP");
    await writeAtomicPrivateFile(provider, "module.exports = class { id(){return 'cyberdeck-host-evidence-v1'} async callApi(prompt){return {output:prompt}} };\n");
    await writeAtomicPrivateFile(config, body);
    const execution = await new PromptfooProcess(this.options.node, [this.options.cli, "eval", "--config", config, "--no-cache", "--max-concurrency", "1", "--output", report], directory, this.options.timeoutMs ?? 60000).run(claim);
    if (execution.timedOut || execution.exitCode === null) return execution;
    try {
      const handle = await open(report, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: string;
      try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > reportCap) throw new Error("PROMPTFOO_REPORT_CAP"); raw = await handle.readFile("utf8"); await handle.sync(); } finally { await handle.close(); }
      const result = parseAttemptReport(JSON.parse(raw), claim, this.options.requiredChecks);
      const reportHash = createHash("sha256").update(raw).digest("hex");
      await writeAtomicPrivateFile(join(directory, `${prefix}.manifest.json`), JSON.stringify({ schemaVersion: 1, evaluator: "promptfoo-0.122.2", key: claim.key, rubricId: claim.intent.rubricId, rubricVersion: claim.intent.rubricVersion, evidenceManifestHash: claim.intent.evidenceManifestHash, report: basename(report), reportHash, result }));
      // Promptfoo exits nonzero for legitimate assertion failures; parsed independent result rules.
      return { ...execution, exitCode: 0, evaluationResult: { ...result, reportHash } };
    } catch { return { ...execution, exitCode: 1, evaluationResult: { disposition: "infrastructure-error", reason: "promptfoo-report-unavailable" } }; }
  }
}
