import type { AgentActivityPort } from "./agent-activity-port.js";
import type { EvaluationReplayStorePort } from "./task-evaluation-ports.js";
import type { TaskEvaluationService } from "./task-evaluation-service.js";
import type { InstructionRecord } from "../domain/instruction.js";
import type { LegacyEvaluationCoveragePort } from "./task-evaluation-legacy.js";

export type EvaluationCoverageAudit = { state: "complete" } | { state: "gap"; reason: string };
export interface EvaluationReplayHealth {
  state: "pending" | "caught-up" | "gap" | "backpressure";
  checkpoint: number; processed: number; reason?: string;
}
export interface EvaluationReconciliationOptions {
  consumer: string; pageSize?: number; maxPages?: number;
  /** Audit the canonical instruction journal independently of its possibly lost activity projection. */
  auditCanonicalCoverage?: () => Promise<EvaluationCoverageAudit>;
}

/** Fsync outbox before checkpoint, and checkpoint before releasing the activity retention fence. */
export class TaskEvaluationReconciliationService {
  private state: EvaluationReplayHealth = { state: "pending", checkpoint: 0, processed: 0 };
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pageSize: number;
  private readonly maxPages: number;
  constructor(private readonly activity: AgentActivityPort, private readonly outbox: EvaluationReplayStorePort,
    private readonly evaluator: Pick<TaskEvaluationService, "observeTerminal">, private readonly options: EvaluationReconciliationOptions) {
    this.pageSize = options.pageSize ?? 100; this.maxPages = options.maxPages ?? 4;
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(options.consumer) || !Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 1000
      || !Number.isSafeInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 100) throw new Error("EVALUATION_REPLAY_OPTIONS_INVALID");
  }
  health(): EvaluationReplayHealth {
    const bounds = this.activity.replayBounds?.();
    if (bounds && this.state.state === "caught-up") {
      if (bounds.captureGaps > 0 || bounds.uncertain) return { ...this.state, state: "gap", reason: "canonical-recorder-loss" };
      if (bounds.sequence < this.state.checkpoint) return { ...this.state, state: "gap", reason: "canonical-history-truncated" };
      if (bounds.sequence > this.state.checkpoint) return { ...this.state, state: "pending" };
    }
    return { ...this.state };
  }
  reconcile(): Promise<EvaluationReplayHealth> {
    const operation = this.tail.then(() => this.replay()); this.tail = operation.catch(() => undefined); return operation;
  }
  private async replay(): Promise<EvaluationReplayHealth> {
    this.state = { state: "pending", checkpoint: this.outbox.checkpoint(this.options.consumer)?.sequence ?? 0, processed: 0 };
    const fail = (state: "gap" | "backpressure", reason: string) => { this.state = { ...this.state, state, reason }; return this.health(); };
    if (!this.activity.readGlobal || !this.activity.replayBounds || !this.activity.retainAfter) return fail("gap", "canonical-recorder-unavailable");
    try {
      const bounds = this.activity.replayBounds(), prior = this.outbox.checkpoint(this.options.consumer);
      if (prior && prior.sourceId !== bounds.sourceId) return fail("gap", "canonical-source-replaced");
      if (this.state.checkpoint > bounds.sequence) return fail("gap", "canonical-history-truncated");
      // Install protection even when existing history has a gap. Never prune additional evidence.
      await this.activity.retainAfter(this.options.consumer, this.state.checkpoint);
      if (!prior) this.outbox.advanceCheckpoint(this.options.consumer, bounds.sourceId, 0, 0);
      for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber++) {
        const before = this.activity.replayBounds();
        if (before.sourceId !== bounds.sourceId || before.uncertain || before.captureGaps > 0) return fail("gap", "canonical-recorder-loss");
        if (before.firstSequence !== null && before.firstSequence > this.state.checkpoint + 1) return fail("gap", "canonical-history-pruned");
        const page = await this.activity.readGlobal(this.state.checkpoint, this.pageSize);
        if (page.length > this.pageSize) return fail("gap", "canonical-page-invalid");
        let sequence = this.state.checkpoint;
        for (const event of page) {
          if (event.sequence !== sequence + 1) return fail("gap", "canonical-sequence-gap");
          await this.evaluator.observeTerminal(event); // FULL SQLite commit or throw; never advance past failure.
          sequence = event.sequence; this.state.processed++;
        }
        if (sequence !== this.state.checkpoint) {
          this.outbox.advanceCheckpoint(this.options.consumer, bounds.sourceId, this.state.checkpoint, sequence);
          this.state.checkpoint = sequence;
          await this.activity.retainAfter(this.options.consumer, sequence);
        }
        const after = this.activity.replayBounds();
        if (after.uncertain || after.captureGaps > 0) return fail("gap", "canonical-recorder-loss");
        if (after.sequence < sequence || page.length === 0 && after.sequence > sequence) return fail("gap", "canonical-history-truncated");
        if (after.sequence === sequence) {
          const audit = await this.options.auditCanonicalCoverage?.();
          if (!audit) return fail("gap", "canonical-instruction-coverage-unavailable");
          if (audit.state === "gap") return fail("gap", audit.reason);
          const audited = this.activity.replayBounds();
          if (audited.sourceId !== bounds.sourceId || audited.uncertain || audited.captureGaps > 0) return fail("gap", "canonical-recorder-loss");
          this.state = { ...this.state, state: audited.sequence === sequence ? "caught-up" : "pending" };
          return this.health();
        }
      }
      return this.health(); // A bounded continuation, not proof that all history was consumed.
    } catch (error) {
      const reason = error instanceof Error && /^EVALUATION_[A-Z_]+$/.test(error.message) ? error.message : "canonical-replay-failed";
      return fail(reason === "EVALUATION_GENERATION_UNKNOWN" || reason === "EVALUATION_EVIDENCE_NOT_CANONICAL" ? "gap" : "backpressure", reason);
    }
  }
}

/** Latest canonical instruction snapshots can detect a missing projection, but cannot recreate
 * its historical generation. The caller supplies a bounded/pageable journal reader. */
export async function auditTerminalInstructions<T extends { id: string; status: string; updatedAt: string }>(
  outbox: Pick<EvaluationReplayStorePort, "hasTerminalSource"> & Partial<LegacyEvaluationCoveragePort>,
  records: AsyncIterable<T> | Iterable<T>,
  maxRecords = 10000,
): Promise<EvaluationCoverageAudit> {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 100000) throw new Error("EVALUATION_AUDIT_LIMIT_INVALID");
  let count = 0;
  for await (const record of records) {
    if (++count > maxRecords) return { state: "gap", reason: "canonical-instruction-audit-limit" };
    if (["completed", "cancelled", "undelivered"].includes(record.status)
      && !outbox.hasTerminalSource(`instruction:${record.id}:${record.status}:${record.updatedAt}`)
      && !outbox.hasLegacyTerminalSnapshot?.(record))
      return { state: "gap", reason: "canonical-instruction-projection-missing" };
  }
  return { state: "complete" };
}

/** Recreate only the projection durably committed by the instruction writer. No live lookups. */
export async function repairTerminalInstructionProjections(
  outbox: Pick<EvaluationReplayStorePort, "hasTerminalSource">,
  activity: Pick<AgentActivityPort, "append">, records: Iterable<InstructionRecord>, maxRecords = 10000,
): Promise<void> {
  let count = 0;
  for (const record of records) {
    if (++count > maxRecords) throw new Error("EVALUATION_CANONICAL_AUDIT_LIMIT");
    if (!["completed", "cancelled", "undelivered"].includes(record.status)) continue;
    const source = `instruction:${record.id}:${record.status}:${record.updatedAt}`;
    if (outbox.hasTerminalSource(source) || !record.terminalActivity) continue;
    const event = record.terminalActivity;
    if (event.sourceKey !== source || event.instructionId !== record.id || event.sessionId !== record.targetSessionId
      || event.generation !== record.attemptGeneration || event.executionId !== record.attemptExecutionId
      || event.provenance !== "broker" || event.kind !== (record.status === "completed" ? "instruction.settled" : `instruction.${record.status}`))
      throw new Error("EVALUATION_CANONICAL_IDENTITY_CONFLICT");
    await activity.append(event);
  }
}
