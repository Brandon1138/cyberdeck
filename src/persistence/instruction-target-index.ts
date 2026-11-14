import type { InstructionRecord } from "../domain/instruction.js";
import type { WorkerTurnLedger } from "../orchestration/session/worker-turn-ports.js";
import type { ThreadEvent } from "../domain/thread.js";
import type { InstructionTurnTarget } from "../orchestration/session/worker-turn-ports.js";

/** Durable admission fences survive process replacement and semantic journal rotation. */
export class InstructionTargetIndex {
  private readonly sessions = new Map<string, Map<number, InstructionTurnTarget>>();
  observe(event: ThreadEvent): void {
    const candidates: unknown[] = Array.isArray(event.data.instructionTargets) ? [...event.data.instructionTargets] : [];
    if (event.kind === "instruction" && event.data.instructionState === "rendered") candidates.push({
      instructionId: event.data.instructionId, expectedTurn: event.data.expectedTurn,
      renderedAt: event.data.renderedAt ?? event.occurredAt,
    });
    this.restore(event.sessionId, candidates);
  }
  restore(sessionId: string, candidates: readonly unknown[]): void {
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const target = candidate as InstructionTurnTarget;
      if (typeof target.instructionId !== "string" || target.instructionId.length === 0
        || !Number.isSafeInteger(target.expectedTurn) || target.expectedTurn <= 0
        || typeof target.renderedAt !== "string" || !Number.isFinite(Date.parse(target.renderedAt))) continue;
      let targets = this.sessions.get(sessionId);
      if (targets === undefined) { targets = new Map(); this.sessions.set(sessionId, targets); }
      const prior = targets.get(target.expectedTurn);
      // A legacy duplicate target is fenced by its latest actual write, never an earlier prompt.
      if (prior === undefined || Date.parse(prior.renderedAt) <= Date.parse(target.renderedAt)) targets.set(target.expectedTurn, { ...target });
      while (targets.size > 64) targets.delete(Math.min(...targets.keys()));
    }
  }
  sessionIds(): string[] { return [...this.sessions.keys()]; }
  remove(sessionId: string): void { this.sessions.delete(sessionId); }
  read(sessionId: string): InstructionTurnTarget[] { return [...(this.sessions.get(sessionId)?.values() ?? [])].map(target => ({ ...target })); }
}

/** Reconcile a lost queue receipt from the existing per-session durable native target index. */
export function indexedInstructionReceipt(record: InstructionRecord, ledger: WorkerTurnLedger): Partial<InstructionRecord> | undefined {
  const target = ledger.instructionTargets?.find(t => t.instructionId === record.id);
  if (!target) return undefined;
  const turn = ledger.turns.find(t => t.data?.turnNumber === target.expectedTurn);
  if (turn?.data?.outcome === "cancelled") return { status: "cancelled", expectedTurn: target.expectedTurn, renderedAt: target.renderedAt };
  if (ledger.canonicalTurns >= target.expectedTurn) return { status: "completed", expectedTurn: target.expectedTurn,
    renderedAt: target.renderedAt, submittedAt: record.submittedAt ?? target.renderedAt, completedAt: target.renderedAt };
  return { status: "rendered", expectedTurn: target.expectedTurn, renderedAt: target.renderedAt };
}
