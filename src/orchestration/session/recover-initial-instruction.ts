import type { SessionRecord } from "../../domain/session.js";
import type { TranscriptLike } from "./session-registry-ports.js";
import type { WorkerTurnObservation } from "./worker-turn-ports.js";

export interface InitialInstructionRecovery {
  completed: boolean;
  unavailable?: string;
}

/** Reconcile the crash window between native completion and the broker's durable turn commit. */
export async function recoverInitialInstruction(record: SessionRecord, transcripts?: TranscriptLike): Promise<InitialInstructionRecovery> {
  if (record.initialInstructionId === undefined || transcripts?.readCompletionLedger === undefined) return { completed: false };
  const ledger = await transcripts.readCompletionLedger(record.id);
  if (ledger.canonicalTurns >= 1) return { completed: true };
  if (transcripts.observeProviderTurns === undefined || transcripts.commitProviderTurns === undefined) return { completed: false };
  let observation: WorkerTurnObservation;
  try {
    observation = await transcripts.observeProviderTurns({
      sessionId: record.id, provider: record.provider, cwd: record.cwd,
      createdAt: record.createdAt, turnNumber: ledger.completedTurns + 1, allowFallback: false,
    });
  } catch {
    // A changing or unavailable provider log must not stop unrelated threads recovering. Do not
    // turn absence of readable evidence into an unconsumed receipt or echo private parser input.
    return { completed: false, unavailable: "Native first-turn evidence could not be read; resume or restart to retry without resending the brief" };
  }
  const native = observation.turns.filter(({ transport }) => transport === "provider-native");
  if (native.length === 0) return { completed: false };
  // Broker ledger and commit failures remain authoritative failures, outside the native-read catch.
  await transcripts.commitProviderTurns({ ...observation, turns: native });
  return { completed: (await transcripts.readCompletionLedger(record.id)).canonicalTurns >= 1 };
}
