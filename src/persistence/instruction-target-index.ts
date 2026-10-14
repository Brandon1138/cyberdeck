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
