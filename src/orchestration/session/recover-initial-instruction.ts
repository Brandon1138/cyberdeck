import type { SessionRecord } from "../../domain/session.js";
import type { TranscriptLike } from "./session-registry-ports.js";

/** Reconcile the crash window between native completion and the broker's durable turn commit. */
export async function initialInstructionCompleted(record: SessionRecord, transcripts?: TranscriptLike): Promise<boolean> {
  if (record.initialInstructionId === undefined || transcripts?.readCompletionLedger === undefined) return false;
  const ledger = await transcripts.readCompletionLedger(record.id);
  if (ledger.canonicalTurns >= 1) return true;
  if (transcripts.observeProviderTurns === undefined || transcripts.commitProviderTurns === undefined) return false;
  const observation = await transcripts.observeProviderTurns({
    sessionId: record.id, provider: record.provider, cwd: record.cwd,
    createdAt: record.createdAt, turnNumber: ledger.completedTurns + 1, allowFallback: false,
  });
  const native = observation.turns.filter(({ transport }) => transport === "provider-native");
  if (native.length === 0) return false;
  await transcripts.commitProviderTurns({ ...observation, turns: native });
  return (await transcripts.readCompletionLedger(record.id)).canonicalTurns >= 1;
}
