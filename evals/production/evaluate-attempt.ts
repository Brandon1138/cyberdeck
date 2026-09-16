import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ResourceAdmissionPort, ResourceRequest } from "../../src/domain/resource-budget.js";
import type { TaskEvaluationResult } from "../../src/domain/task-evaluation.js";
import { evidenceHash, type EvaluationClaim, TaskEvaluationStore } from "../../src/persistence/task-evaluation-store.js";

/** Independent checks consume host evidence; worker prose has no grading authority. */
export function evaluateEvidence(claim: EvaluationClaim, requiredChecks: readonly string[] = []): TaskEvaluationResult {
  const manifest = claim.manifest;
  if (evidenceHash(manifest) !== claim.intent.evidenceManifestHash) return { disposition: "unverified", reason: "evidence-hash-mismatch" };
  const event = manifest.terminalEvent as { outcome?: string; kind?: string };
  if (event.outcome === "cancelled" || event.kind === "instruction.cancelled") return { disposition: "cancelled", reason: "canonical-cancellation" };
  if (event.kind === "execution.lifecycle" && event.outcome === "failed") return { disposition: "infrastructure-error", reason: "execution-failed" };
  if (!manifest.complete || !requiredChecks.length || requiredChecks.some(id => manifest.checks.filter(c => c.id === id).length !== 1)) return { disposition: "unverified", reason: "missing-independent-evidence" };
  if (manifest.checks.some(c => c.source !== "host-verified" || !/^[a-f0-9]{64}$/.test(c.artifactHash))) return { disposition: "unverified", reason: "untrusted-check" };
  return { disposition: manifest.checks.filter(c => requiredChecks.includes(c.id)).every(c => c.passed) ? "verified-pass" : "verified-fail", reason: "independent-host-checks" };
}

export interface EvaluationProcessResult { exitCode: number | null; timedOut: boolean; output: string; terminationEvidenceId: string; evaluationResult?: TaskEvaluationResult }
export interface EvaluationProcessPort { run(claim: EvaluationClaim): Promise<EvaluationProcessResult> }
/** Construct only in the separate evaluator supervisor. No Promptfoo engine enters the broker.
 * Command/config must be host-owned, offline and fixed; never accept worker argv or judge keys. */
export class PromptfooProcess implements EvaluationProcessPort {
  constructor(private readonly executable: string, private readonly args: readonly string[], private readonly cwd: string,
    private readonly timeoutMs = 60000, private readonly outputCap = 65536) {}
  run(_claim: EvaluationClaim): Promise<EvaluationProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...this.args], { cwd: this.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", HOME: this.cwd, PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_DISABLE_UPDATE: "1" } });
      let output = "", timedOut = false;
      const kill = (): void => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") reject(e); } } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, this.timeoutMs);
      const capture = (data: Buffer): void => { output += data.toString("utf8"); if (Buffer.byteLength(output) > this.outputCap) { output = output.slice(0, this.outputCap / 4); timedOut = true; kill(); } };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", exitCode => {
        clearTimeout(timer); kill();
        // A process group that survived direct-child exit is not confirmed terminated.
        if (child.pid) { try { process.kill(-child.pid, 0); reject(new Error("EVALUATOR_DESCENDANTS_UNCONFIRMED")); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") { reject(e); return; } } }
        resolve({ exitCode, timedOut, output, terminationEvidenceId: `evaluator-exit:${child.pid}:${Date.now()}` });
      });
    });
  }
}

export async function evaluateNext(store: TaskEvaluationStore, admission: ResourceAdmissionPort, request: ResourceRequest,
  runner: EvaluationProcessPort, now: () => number = Date.now, requiredChecks: readonly string[] = []): Promise<"empty" | "waiting" | "finished"> {
  const decision = await admission.request(request);
  if (decision.state !== "admitted") return "waiting";
  const claim = store.claim(now(), 300000);
  if (!claim) { await admission.release({ reservationId: decision.reservationId, terminationEvidenceId: `no-evaluator-started:${request.requestId}` }); return "empty"; }
  let result: TaskEvaluationResult;
  try {
    const execution = await runner.run(claim);
    await admission.release({ reservationId: decision.reservationId, terminationEvidenceId: execution.terminationEvidenceId });
    result = execution.timedOut || execution.exitCode !== 0
      ? { disposition: "infrastructure-error", reason: execution.timedOut ? "evaluator-timeout" : "evaluator-process-failed" }
      : execution.evaluationResult ?? { ...evaluateEvidence(claim, requiredChecks), reportHash: createHash("sha256").update(execution.output).digest("hex") };
  } catch {
    // Without exit evidence retain the reservation. Recovery must reconcile process reality.
    result = { disposition: "infrastructure-error", reason: "evaluator-exit-unconfirmed" };
  }
  store.finish(claim, result, now());
  store.acknowledge(claim.key);
  return "finished";
}
