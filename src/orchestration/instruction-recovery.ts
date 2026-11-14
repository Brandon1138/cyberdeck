import type { InstructionRecord } from "../domain/instruction.js";
import type { InstructionStateUpdate } from "./session/session-ports.js";
import type { WorkerTurnLedger } from "./session/worker-turn-ports.js";

/** Queue subscription can follow engine restoration. Replay exact identities, then re-arm holds. */
export async function recoverPendingInstructions(records: InstructionRecord[],
  readLedger: (sessionId: string) => Promise<WorkerTurnLedger>,
  apply: (update: InstructionStateUpdate) => Promise<void>, flush: (sessionId: string) => Promise<unknown>): Promise<void> {
  const pending = records.filter(record => record.launch === undefined
    && !["completed", "cancelled", "undelivered"].includes(record.status));
  for (const sessionId of new Set(pending.map(record => record.targetSessionId))) {
    const ledger = await readLedger(sessionId);
    for (const record of pending.filter(record => record.targetSessionId === sessionId)) {
      const target = ledger.instructionTargets?.find(target => target.instructionId === record.id);
      if (target === undefined || (record.expectedTurn !== undefined && record.expectedTurn !== target.expectedTurn)) continue;
      const receipt = ledger.turns.find(turn => turn.data?.turnNumber === target.expectedTurn);
      if (receipt === undefined) continue;
      await apply({ sessionId, instructionId: record.id, turn: target.expectedTurn,
        state: receipt.data?.outcome === "cancelled" ? "cancelled" : "completed", at: new Date().toISOString() });
    }
    await flush(sessionId);
  }
}
