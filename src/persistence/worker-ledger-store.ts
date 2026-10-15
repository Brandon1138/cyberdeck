import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ThreadEventSchema } from "../domain/thread.js";
import type { WorkerTurnLedger, WorkerTurnTranscript, WorkerTurnObservation } from "../orchestration/session/worker-turn-ports.js";
import { writeAtomicPrivateFile } from "./atomic-private-file.js";

const Target = z.object({ instructionId: z.string().min(1), expectedTurn: z.number().int().positive(), renderedAt: z.iso.datetime() });
const Ledger = z.object({ sessionId: z.uuid(), completedTurns: z.number().int().nonnegative(), canonicalTurns: z.number().int().nonnegative(),
  providerOccurredThrough: z.iso.datetime().optional(), turns: z.array(ThreadEventSchema).max(64),
  lastNativeTurn: ThreadEventSchema.optional(), instructionTargets: z.array(Target).max(64) });

export const WORKER_LEDGER_REJECTIONS = ["WORKER_LEDGER_INVALID", "WORKER_LEDGER_CONFLICT"] as const;

/**
 * The one shape check, run on every read and every write so the two can never disagree about
 * what a valid ledger is. `completedTurns` is the highest ordinal any turn was filed under and
 * `canonicalTurns` counts distinct provider-native turns; a session whose ordinals were reused
 * (an adopt or restart handing out turn 1 again while native turn ids kept advancing) legitimately
 * has a count above its max ordinal, so the two are deliberately not compared.
 */
function assertLedger<T extends z.infer<typeof Ledger>>(sessionId: string, ledger: T): T {
  const receipts = [...ledger.turns, ...(ledger.lastNativeTurn === undefined ? [] : [ledger.lastNativeTurn])];
  if (ledger.sessionId !== sessionId || receipts.some(turn => turn.sessionId !== sessionId)) throw new Error("WORKER_LEDGER_CONFLICT");
  if (receipts.some(turn => !Number.isSafeInteger(turn.data.turnNumber)
    || Number(turn.data.turnNumber) <= 0 || Number(turn.data.turnNumber) > ledger.completedTurns
    || typeof turn.data.semanticTurnId !== "string" || !["provider-native", "terminal-replay-fallback", "broker-lifecycle"].includes(String(turn.data.transport)))) throw new Error("WORKER_LEDGER_INVALID");
  return ledger;
}

/** Receipt and admission truth is independent of the shared transcript's retention window. */
export class WorkerLedgerStore {
  private readonly directory: string;
  private readonly writes = new Map<string, Promise<void>>();
  constructor(stateDirectory: string) { this.directory = join(stateDirectory, "threads", "turn-ledgers"); }
  private path(sessionId: string): string { return join(this.directory, `${z.uuid().parse(sessionId)}.json`); }
  async read(sessionId: string): Promise<WorkerTurnLedger | undefined> {
    const file = await open(this.path(sessionId), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (file === undefined) return undefined;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) throw new Error("WORKER_LEDGER_INVALID");
      const ledger = assertLedger(sessionId, Ledger.parse(JSON.parse(await file.readFile("utf8"))));
      return { completedTurns: ledger.completedTurns, canonicalTurns: ledger.canonicalTurns, turns: ledger.turns,
        instructionTargets: ledger.instructionTargets,
        ...(ledger.providerOccurredThrough === undefined ? {} : { providerOccurredThrough: ledger.providerOccurredThrough }),
        ...(ledger.lastNativeTurn === undefined ? {} : { lastNativeTurn: ledger.lastNativeTurn }) };
    } finally { await file.close(); }
  }
  write(sessionId: string, ledger: WorkerTurnLedger): Promise<void> { return this.serialize(sessionId, () => this.persist(sessionId, ledger)); }
  private async persist(sessionId: string, ledger: WorkerTurnLedger): Promise<void> {
    const compact = (turn: WorkerTurnTranscript) => ({ ...turn,
      ...(turn.text !== undefined && turn.text.length > 6000 ? { text: `[receipt elision; original length ${turn.text.length}]\n${turn.text.slice(-6000)}`,
        data: { ...turn.data, receiptOriginalLength: turn.text.length } } : {}) });
    const body = assertLedger(sessionId, Ledger.parse({ ...ledger, sessionId, turns: ledger.turns.map(compact),
      ...(ledger.lastNativeTurn === undefined ? {} : { lastNativeTurn: compact(ledger.lastNativeTurn) }), instructionTargets: ledger.instructionTargets ?? [] }));
    await writeAtomicPrivateFile(this.path(sessionId), JSON.stringify(body));
  }
  /** Move a ledger `read` refused out of the way so startup can rebuild it from the transcript. Returns the new path. */
  quarantine(sessionId: string, reason: string): Promise<string> {
    const source = this.path(sessionId);
    const target = `${source}.${reason.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    return this.serialize(sessionId, () => rename(source, target)).then(() => target);
  }
  remove(sessionId: string): Promise<void> { return this.serialize(sessionId, async () => {
    await unlink(this.path(sessionId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }); }
  private serialize(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const pending = (this.writes.get(sessionId) ?? Promise.resolve()).then(operation, operation);
    this.writes.set(sessionId, pending);
    void pending.finally(() => { if (this.writes.get(sessionId) === pending) this.writes.delete(sessionId); }).catch(() => undefined);
    return pending;
  }
}

/** Exact bounded payload shared by append and dedupe acknowledgements. */
export function providerTurnReceipt(observation: WorkerTurnObservation, turn: WorkerTurnObservation["turns"][number],
  turnNumber: number, text: string, canonicalTurns: number): { text: string; data: Record<string, unknown> } {
  const data = {
    semantic: true, semanticTurnId: `${observation.provider}:${turn.providerTurnId}`,
    provider: observation.provider, transport: turn.transport, originalLength: turn.text.length,
    turnNumber, providerOccurredAt: turn.providerOccurredAt,
    ...(observation.provider === "claude" || observation.provider === "codex"
      ? { canonicalTurns: canonicalTurns + (turn.transport === "provider-native" ? 1 : 0) } : {}),
    ...(turn.data ?? {}),
  };
  return { text, data: text === turn.text ? data : { ...data, storageOriginalLength: turn.text.length } };
}

export function mergeWorkerLedgers(stored: WorkerTurnLedger | undefined, current: WorkerTurnLedger | undefined): WorkerTurnLedger {
  const turns = new Map<number, WorkerTurnTranscript>();
  for (const turn of [...stored?.turns ?? [], ...current?.turns ?? []]) if (typeof turn.data?.turnNumber === "number") turns.set(turn.data.turnNumber, turn);
  const native = [stored?.lastNativeTurn, current?.lastNativeTurn, ...turns.values()].filter(turn => turn?.data?.transport === "provider-native")
    .sort((a, b) => Number(a?.data?.turnNumber) - Number(b?.data?.turnNumber)).at(-1);
  const through = [stored?.providerOccurredThrough, current?.providerOccurredThrough].filter(value => value !== undefined).sort().at(-1);
  return { completedTurns: Math.max(stored?.completedTurns ?? 0, current?.completedTurns ?? 0),
    canonicalTurns: Math.max(stored?.canonicalTurns ?? 0, current?.canonicalTurns ?? 0),
    turns: [...turns.entries()].sort(([a], [b]) => a - b).slice(-64).map(([, turn]) => turn),
    ...(native === undefined ? {} : { lastNativeTurn: native }), ...(through === undefined ? {} : { providerOccurredThrough: through }) };
}
