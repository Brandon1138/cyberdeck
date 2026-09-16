import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ResourceAdmissionPort, ResourceReservation } from "../../domain/resource-budget.js";
import { TaskEvaluationIntentSchema, type TaskEvaluationIntent } from "../../domain/task-evaluation.js";
import { type EvaluationClaim, evaluationKey, evidenceHash, TaskEvaluationStore } from "../../persistence/task-evaluation-store.js";
import { writeAtomicPrivateFile } from "../../persistence/atomic-private-file.js";
import type { OrbStackClient } from "./orbstack-client.js";
import { parseAttemptReport } from "./task-evaluation-executor-report.js";
import { bytesHash, evaluatorHash, EvaluatorFiles, EvaluatorStateSchema, INPUT_CAP, REPORT_CAP, type EvaluatorState } from "./task-evaluation-executor-state.js";
import { EvaluatorEngine } from "./task-evaluation-executor-engine.js";
import { z } from "zod";

export interface TaskEvaluationExecutorOptions {
  client: OrbStackClient; store: TaskEvaluationStore; admission: ResourceAdmissionPort; image: string;
  installationId: string; directory: string; memoryBytes?: number; retentionBytes?: number;
  /** Historical canonical authority, or an explicitly selected operator background bucket. */
  resolveFamily(intent: TaskEvaluationIntent): Promise<string>;
  requiredChecks(intent: TaskEvaluationIntent): readonly string[];
  now?: () => number; pause?: (ms: number) => Promise<void>;
}
export type EvaluatorProgress = { state: "empty" | "waiting" | "finished" | "blocked"; reason?: string; runId?: string };
export class TaskEvaluationExecutor {
  private readonly files: EvaluatorFiles;
  private readonly engine: EvaluatorEngine;
  private readonly memory: number;
  private readonly now: () => number;
  private readonly pause: (ms: number) => Promise<void>;
  private busy = false;
  private reconciled = false;
  private status: EvaluatorProgress = { state: "blocked", reason: "reconciliation-required" };
  constructor(private readonly options: TaskEvaluationExecutorOptions) {
    this.memory = options.memoryBytes ?? 768 * 1024 ** 2;
    if (!/^sha256:[a-f0-9]{64}$/.test(options.image) || !options.installationId || !Number.isSafeInteger(this.memory)
      || this.memory < 512 * 1024 ** 2 || this.memory > 8 * 1024 ** 3) throw new Error("EVALUATOR_PROFILE_INVALID");
    this.files = new EvaluatorFiles(resolve(options.directory), options.retentionBytes);
    this.engine = new EvaluatorEngine(options.client, this.files);
    this.now = options.now ?? Date.now; this.pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  health() { return { ...this.status, running: this.busy, reconciled: this.reconciled, memoryBytes: this.memory, retentionBytes: this.files.capBytes }; }
  async runNext(signal?: AbortSignal): Promise<EvaluatorProgress> {
    if (!this.reconciled || this.busy) return { state: "blocked", reason: this.busy ? "busy" : "reconciliation-required" };
    return this.exclusive(async () => {
      const entries = await this.inventory(), active = entries.filter(e => !e.settled || !e.released);
      if (active.length > 1) throw new Error("EVALUATOR_RECONCILIATION_REQUIRED");
      let state = active[0];
      if (!state) {
        await this.files.reserveDisk(async state => !await this.engine.inspect(state));
        const claim = this.options.store.claim(this.now(), 300000);
        if (!claim) return { state: "empty" };
        claim.intent = TaskEvaluationIntentSchema.parse(claim.intent);
        const family = await this.options.resolveFamily(claim.intent);
        if (!family || family.length > 256) throw new Error("EVALUATOR_FAMILY_UNAVAILABLE");
        const checks = [...this.options.requiredChecks(claim.intent)], runId = randomUUID();
        const input = JSON.stringify({ version: 1, intent: claim.intent, manifest: claim.manifest, requiredChecks: checks });
        if (Buffer.byteLength(input) > INPUT_CAP) throw new Error("EVALUATOR_INPUT_CAP");
        state = EvaluatorStateSchema.parse({ version: 1, runId, image: this.options.image, claim, inputHash: bytesHash(input), requiredChecks: checks,
          resource: { requestId: `evaluator-${runId}`, owner: { installationId: this.options.installationId, workloadId: `evaluator-${runId}`,
            familyId: family, kind: "evaluation", generation: claim.intent.generation, ...(claim.intent.executionId ? { executionId: claim.intent.executionId } : {}) },
          priority: "background", demand: { memoryBytes: this.memory, cpuWeight: 10, pidLimit: 64, profileId: "offline-promptfoo",
            profileVersion: evaluatorHash({ image: this.options.image, memory: this.memory, version: 1 }) } },
          phase: "waiting", cleanupConfirmed: false, released: false, settled: false });
        await this.files.save(state); // Durable intent before admission, including the reserve-before-save crash window.
        await this.files.input(runId, input);
      }
      if (state.phase !== "waiting") { await this.cleanup(state); return { state: "finished", runId: state.runId }; }
      const decision = await this.options.admission.request(state.resource);
      if (decision.state === "admitted") { state.reservationId = decision.reservationId; await this.files.save(state); }
      if (state.claim.expiresAt <= this.now()) {
        if (!state.reservationId) await this.options.admission.cancel(state.resource.requestId);
        state.reclaimable = true; await this.cleanup(state);
        return { state: "waiting", reason: "claim-expired-reclaimable", runId: state.runId };
      }
      if (decision.state !== "admitted") return { state: "waiting", reason: decision.state, runId: state.runId };
      try {
        if (signal?.aborted) throw new Error("EVALUATOR_INTERRUPTED");
        const input = await this.files.read(this.files.path(state.runId, "input.json"), INPUT_CAP);
        if (bytesHash(input) !== state.inputHash) throw new Error("EVALUATOR_INPUT_MISMATCH");
        if (await this.engine.inspect(state)) throw new Error("EVALUATOR_ALREADY_EXISTS");
        state.phase = "launching"; await this.files.save(state);
        await this.engine.command(this.engine.args(state));
        const created = await this.engine.inspect(state);
        if (!created || created.State.Running) throw new Error("EVALUATOR_CREATE_UNCONFIRMED");
        this.engine.verify(state, created); state.backendId = created.Id; await this.files.save(state);
        await this.engine.command(["start", created.Id]); state.phase = "running"; await this.files.save(state);
        const deadline = this.now() + 60000;
        for (;;) {
          if (signal?.aborted) throw new Error("EVALUATOR_INTERRUPTED");
          const current = await this.engine.inspect(state);
          if (!current) throw new Error("EVALUATOR_DISAPPEARED");
          this.engine.verify(state, current);
          if (!current.State.Running) break;
          if (this.now() >= deadline) throw new Error("EVALUATOR_TIMEOUT");
          await this.pause(250);
        }
      } catch (error) {
        state.result = { disposition: "infrastructure-error", reason: error instanceof Error && error.message === "EVALUATOR_TIMEOUT" ? "evaluator-timeout" : "evaluator-runtime-failed" };
      }
      await this.cleanup(state);
      return { state: "finished", runId: state.runId };
    });
  }
  /** Startup stops/collects only this installation's durable runs before new claims can launch. */
  async reconcile(): Promise<EvaluatorProgress> {
    if (this.busy) return { state: "blocked", reason: "busy" };
    this.reconciled = false;
    return this.exclusive(async () => {
      for (const state of await this.inventory()) {
        if (state.settled && state.released) {
          if (await this.engine.inspect(state)) throw new Error("EVALUATOR_RETIRED_CONTAINER_PRESENT");
          continue;
        }
        if (!state.reservationId) {
          const decision = await this.options.admission.request(state.resource);
          if (decision.state === "admitted") { state.reservationId = decision.reservationId; await this.files.save(state); }
          else await this.options.admission.cancel(state.resource.requestId);
        }
        if (state.phase === "waiting") state.reclaimable = true;
        await this.cleanup(state);
      }
      this.reconciled = true; return { state: "empty" };
    });
  }
  async verifyTermination(reservation: ResourceReservation, evidenceId: string): Promise<boolean> {
    const run = reservation.request.requestId.replace(/^evaluator-/, "");
    if (!z.uuid().safeParse(run).success) return false;
    try {
      const state = EvaluatorStateSchema.parse(JSON.parse(await this.files.read(this.files.path(run, "state.json"), INPUT_CAP * 2)));
      return state.cleanupConfirmed && state.reservationId === reservation.reservationId
        && evaluatorHash(state.resource) === evaluatorHash(reservation.request) && this.terminationId(state) === evidenceId
        && !await this.engine.inspect(state); // Fresh daemon confirmation, not a historical receipt alone.
    } catch { return false; }
  }
  private terminationId(state: EvaluatorState): string {
    return evaluatorHash({ run: state.runId, resource: state.resource, reservation: state.reservationId, backend: state.backendId ?? null, absent: true });
  }
  private async inventory(): Promise<EvaluatorState[]> {
    const entries = await this.files.inventory();
    for (const { state } of entries) if (state.resource.owner.installationId !== this.options.installationId
      || state.resource.requestId !== `evaluator-${state.runId}` || state.resource.owner.kind !== "evaluation"
      || state.resource.owner.workloadId !== `evaluator-${state.runId}` || !state.resource.owner.familyId
      || state.resource.owner.generation !== state.claim.intent.generation || state.resource.owner.executionId !== state.claim.intent.executionId
      || state.claim.key !== evaluationKey(state.claim.intent) || evidenceHash((state.claim as EvaluationClaim).manifest) !== state.claim.intent.evidenceManifestHash
      || state.inputHash !== bytesHash(JSON.stringify({ version: 1, intent: state.claim.intent, manifest: state.claim.manifest, requiredChecks: state.requiredChecks }))
      || state.resource.priority !== "background" || state.resource.demand.profileId !== "offline-promptfoo"
      || state.resource.demand.cpuWeight !== 10 || state.resource.demand.pidLimit !== 64
      || state.resource.demand.memoryBytes < 512 * 1024 ** 2 || state.resource.demand.memoryBytes > 8 * 1024 ** 3
      || state.resource.demand.profileVersion !== evaluatorHash({ image: state.image, memory: state.resource.demand.memoryBytes, version: 1 })
      || state.released && !state.cleanupConfirmed || state.settled && !state.released) throw new Error("EVALUATOR_STATE_MISMATCH");
    return entries.map(e => e.state);
  }
  private async cleanup(state: EvaluatorState): Promise<void> {
    state.phase = "cleanup"; await this.files.save(state);
    let current = await this.engine.inspect(state);
    if (state.released && current) throw new Error("EVALUATOR_RETIRED_CONTAINER_PRESENT");
    if (current?.State.Running) {
      state.result ??= { disposition: "infrastructure-error", reason: "evaluator-interrupted" };
      await this.engine.command(["stop", "--timeout", "5", current.Id]); current = await this.engine.inspect(state);
    }
    if (current) {
      if (current.State.Running || current.State.Pid !== 0) throw new Error("EVALUATOR_CGROUP_TERMINATION_UNCONFIRMED");
      state.backendId = current.Id; state.exit = { exitCode: current.State.ExitCode, oomKilled: current.State.OOMKilled };
      const raw = await this.engine.command(["logs", current.Id]);
      if (Buffer.byteLength(raw) <= REPORT_CAP) await writeAtomicPrivateFile(this.files.path(state.runId, "report.json"), raw);
      if (current.State.OOMKilled) state.result = { disposition: "infrastructure-error", reason: "evaluator-oom" };
      if (!state.result) {
        try {
          if (current.State.ExitCode !== 0 || Buffer.byteLength(raw) > REPORT_CAP) throw new Error();
          const report = z.object({ version: z.literal(1), inputHash: z.literal(state.inputHash), report: z.unknown() }).strict().parse(JSON.parse(raw));
          state.result = { ...parseAttemptReport(report.report, state.claim as EvaluationClaim, state.requiredChecks), reportHash: bytesHash(raw) };
        } catch { state.result = { disposition: "infrastructure-error", reason: "evaluator-report-invalid" }; }
      }
      await this.files.save(state); // Preserve bounded report and exit/OOM evidence before destruction.
      await this.engine.command(["rm", current.Id]);
    } else if (!state.reclaimable) state.result ??= { disposition: "infrastructure-error", reason: "evaluator-report-unavailable" };
    if (await this.engine.inspect(state)) throw new Error("EVALUATOR_REMOVAL_UNCONFIRMED");
    state.cleanupConfirmed = true; state.phase = "retained"; await this.files.save(state); await this.settle(state);
  }
  private async settle(state: EvaluatorState): Promise<void> {
    if (!state.released) {
      if (state.reservationId) await this.options.admission.release({ reservationId: state.reservationId, terminationEvidenceId: this.terminationId(state) });
      state.released = true; await this.files.save(state);
    }
    if (!state.settled) {
      if (this.options.store.result(state.claim.key)) this.options.store.acknowledge(state.claim.key);
      else if (state.result && state.claim.expiresAt > this.now() && !state.reclaimable) {
        this.options.store.finish(state.claim as EvaluationClaim, state.result, this.now()); this.options.store.acknowledge(state.claim.key);
      } else state.reclaimable = true; // Capacity waiting/expired leases never manufacture a task failure.
      state.settled = true; await this.files.save(state);
    }
  }
  private async exclusive(operation: () => Promise<EvaluatorProgress>): Promise<EvaluatorProgress> {
    this.busy = true;
    try { this.status = await operation(); }
    catch (error) { this.status = { state: "blocked", reason: error instanceof Error && /^EVALUATOR_[A-Z_]+$/.test(error.message) ? error.message : "evaluator-operation-failed" }; }
    finally { this.busy = false; }
    return { ...this.status };
  }
}
