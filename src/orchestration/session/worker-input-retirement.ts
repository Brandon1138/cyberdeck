import { advanceInstruction, type InstructionLifecycleState } from "../../domain/worker-truth.js";
import type { SessionRecord } from "../../domain/session.js";
import type { InstructionStateUpdate } from "./session-ports.js";
import type { InstructionTurnTarget, WorkerTurnObservation } from "./worker-turn-ports.js";
import type { RenderedInstruction } from "./worker-turn-state.js";

export function advanceRendered(sessionId: string, entries: RenderedInstruction[], state: InstructionLifecycleState,
  turn: number | undefined, notify: (update: InstructionStateUpdate) => void): RenderedInstruction[] {
  const at = new Date().toISOString(), remaining: RenderedInstruction[] = [];
  for (const entry of entries) {
    const settles = state === "completed" || state === "cancelled";
    const applies = turn === undefined || entry.expectedTurn === turn;
    const path = settles ? ["submitted", "acknowledged", state] as const : [state] as const;
    if (applies) for (const step of path) {
      const next = advanceInstruction(entry.state, step);
      if (next === entry.state) continue;
      entry.state = next;
      notify({ sessionId, instructionId: entry.instructionId, state: next, at, ...(turn === undefined ? {} : { turn }) });
    }
    if (entry.state !== "completed" && entry.state !== "undelivered" && entry.state !== "cancelled") remaining.push(entry);
  }
  return remaining;
}

export function settleRetiredInstruction(sessionId: string, entries: RenderedInstruction[], target: number,
  abandoned: boolean, outcome: "completed" | "cancelled" | undefined, notify: (update: InstructionStateUpdate) => void): RenderedInstruction[] {
  const entry = entries.find(value => value.expectedTurn === target);
  if (entry === undefined) return entries;
  const state = !abandoned && outcome !== undefined ? outcome
    : entry.state === "submitted" || entry.state === "acknowledged" ? "cancelled" : "undelivered";
  return advanceRendered(sessionId, entries, state, target, notify);
}

/** Assigned targets cannot be reused after their process generation ends without answering. */
export class WorkerInputRetirement {
  private readonly targets = new Map<number, InstructionTurnTarget>();
  pending: Promise<void> = Promise.resolve();
  private retiring = 0;
  private failed = false;
  private retired = false;
  cancel(): void { this.retired = true; }
  get busy(): boolean { return this.retiring > 0 || this.failed; }
  constructor(private readonly host: { record(): SessionRecord; completed(): number; protect(target: number): void; needsSettlement(target: number): boolean; finished(): void; settle(target: number, abandoned: boolean): void; commit(observation: WorkerTurnObservation): Promise<void> }) {}
  /** Launch argv alone is not admission; retirement starts when its turn is submitted. */
  remember(target: InstructionTurnTarget): void {
    this.targets.set(target.expectedTurn, target);
    this.host.protect(target.expectedTurn);
    while (this.targets.size > 64) this.targets.delete(Math.min(...this.targets.keys()));
  }
  restore(targets: readonly InstructionTurnTarget[] = []): void { for (const target of targets) this.remember(target); }
  snapshot(): InstructionTurnTarget[] { return [...this.targets.values()]; }
  retire(before: () => Promise<unknown>): void {
    const targets = this.snapshot().filter(target => target.expectedTurn > this.host.completed() || this.host.needsSettlement(target.expectedTurn));
    if (targets.length === 0) return;
    this.retiring += 1;
    this.pending = this.pending.then(async () => {
      await before();
      if (this.retired) return;
      for (const target of targets.sort((a, b) => a.expectedTurn - b.expectedTurn)) {
        if (target.expectedTurn <= this.host.completed()) { this.host.settle(target.expectedTurn, false); continue; }
        if (target.expectedTurn !== this.host.completed() + 1) throw new Error("INSTRUCTION_TARGET_RETIREMENT_GAP");
        const record = this.host.record();
        await this.host.commit({ sessionId: record.id, provider: record.provider, turnNumber: target.expectedTurn,
          turns: [{ providerTurnId: `broker-instruction:${target.instructionId}`, providerOccurredAt: new Date().toISOString(),
            text: "Instruction target cancelled when its process generation ended", transport: "broker-lifecycle",
            data: { outcome: "cancelled", instructionId: target.instructionId, instructionTargets: [target] } }] });
        this.host.settle(target.expectedTurn, true);
      }
    }).catch(error => { if (this.retired) return; this.failed = true; throw error; }).finally(() => { this.retiring -= 1; if (!this.busy && !this.retired) this.host.finished(); });
    void this.pending.catch(() => undefined); // The lifecycle barrier owns failure and refuses resume.
  }
}
