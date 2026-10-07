import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { z } from "zod";
import type { InstructionRecord } from "../../domain/instruction.js";
import type { SessionRecord } from "../../domain/session.js";
import type { ThreadEvent, ThreadReadResult } from "../../domain/thread.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import { claudeActivity } from "./claude-activity.js";
import { codexActivity } from "./codex-activity.js";
import { NativeActivityCursor } from "./native-activity-cursor.js";
import type { PendingNativeInterval } from "./container-native-source.js";
import { activityIdentity, object, type ActivityAttribution } from "./provider-activity-collector.js";
import { openContainedSource } from "./contained-source.js";
import { nativeSourceLinesFromFile } from "./native-source-lines.js";

export const NativeIntervalSchema = z.object({ sourceRoot: z.string(), path: z.string(), fromOffset: z.number().int().nonnegative(),
  throughOffset: z.number().int().positive(), generation: z.number().int().positive(), executionId: z.uuid(),
  startedAt: z.iso.datetime().optional(), providerTurnId: z.string().optional() }).strict();
export type NativeInterval = z.infer<typeof NativeIntervalSchema>;

interface Transcripts { read(id: string, after?: number, limit?: number): Promise<ThreadReadResult> }
interface Instructions { list(targetSessionId?: string): Promise<InstructionRecord[]> }
type Attributed = { attribution: ActivityAttribution; turnParentId?: string } | { deferred: "rendered-only" } | { conflict: true };
interface ParkingCaptureFact {
  identity: string; turn: number; pending: number; revision: number; complete: boolean;
  source?: { path: string; stamp: string };
}
function captureIdentity(session: SessionRecord): string {
  return JSON.stringify([session.id, session.provider, session.executor, session.generation, session.execution?.executionId, session.execution?.generation]);
}
function fileStamp(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error("NATIVE_PARKING_SOURCE_UNSAFE");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** A rendered instruction proves bytes in an input surface; only consumption binds a turn to it. */
const CONSUMED = new Set<InstructionRecord["status"]>(["submitted", "acknowledged", "completed"]);
const CLAIMING = new Set<InstructionRecord["status"]>(["rendered", "submitted", "acknowledged", "completed"]);

/**
 * Binds each container-native turn interval to what dispatched it, using only durable records:
 * the instruction record whose `expectedTurn` names the turn, the launch prompt, or a human
 * composer prompt in the thread transcript. Byte cursors keep running-turn and completed-turn
 * reads on one identity per semantic turn. Nothing here infers attribution from time or cwd.
 */
export class TurnNativeCapture {
  private readonly cursor: NativeActivityCursor;
  private readonly running = new Set<string>();
  private readonly parking = new Map<string, ParkingCaptureFact>();
  constructor(directory: string, private readonly recorder: AgentActivityPort,
    private readonly transcripts: Transcripts, private readonly instructions: Instructions,
  ) { this.cursor = new NativeActivityCursor(directory, recorder); }

  /** Exact current native turn only. No completion badge or retained event count can grant zero. */
  outstandingTools(session: SessionRecord, turnNumber: number): number | null {
    const fact = this.parking.get(session.id);
    if (!fact || fact.identity !== captureIdentity(session) || fact.turn !== turnNumber || fact.pending !== 0
      || !fact.complete || !fact.source || this.recorder.health().degraded || this.recorder.health().dropped > 0) return null;
    try { return fileStamp(fact.source.path) === fact.source.stamp ? 0 : null; } catch { return null; }
  }
  invalidate(sessionId: string): void {
    const fact = this.parking.get(sessionId);
    if (fact) { fact.revision++; fact.complete = false; delete fact.source; }
  }
  forget(sessionId: string): void { this.parking.delete(sessionId); }
  private begin(session: SessionRecord, turn: number): { fact: ParkingCaptureFact; revision: number } {
    const identity = captureIdentity(session);
    let fact = this.parking.get(session.id);
    if (!fact || fact.identity !== identity) {
      fact = { identity, turn, pending: 0, revision: 0, complete: false }; this.parking.set(session.id, fact);
    }
    fact.pending++; fact.revision++; fact.complete = false; delete fact.source;
    fact.turn = Math.max(fact.turn, turn);
    while (this.parking.size > 128) this.parking.delete(this.parking.keys().next().value!);
    return { fact, revision: fact.revision };
  }

  /** Instruction settlement: a completed record owns its receipt; an abandoned one re-attributes the turn it claimed. */
  async captureInstruction(record: InstructionRecord, session: SessionRecord | undefined): Promise<void> {
    if (!["completed", "undelivered", "cancelled"].includes(record.status)) return;
    try {
      if (session?.executor !== "orbstack-container" || !record.expectedTurn || !session.generation) throw new Error("NATIVE_CAPTURE_UNAVAILABLE");
      const receipt = await this.receipt(session.id, record.expectedTurn);
      if (!receipt) { if (record.status === "completed") throw new Error("NATIVE_RECEIPT_AMBIGUOUS"); return; }
      if (receipt.data.transport !== "provider-native") throw new Error("NATIVE_RECEIPT_AMBIGUOUS");
      await this.captureCompleted(session, receipt, record.status === "completed" ? record : undefined);
    } catch {
      this.invalidate(record.targetSessionId);
      await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `native-capture-failed:${record.id}`,
        runId: record.workflowRunId ?? record.id, instructionId: record.id, sessionId: record.targetSessionId, workerId: record.targetSessionId,
        observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture", provenance: "broker",
        coverage: "unavailable", outcome: "unknown", gap: "unsupported-source" }).catch(() => undefined);
    }
  }

  /** A durable semantic receipt names an exact interval; capture it under the identity that dispatched it. */
  async captureCompleted(session: SessionRecord, receipt: ThreadEvent, settled?: InstructionRecord): Promise<void> {
    const claimedTurn = typeof receipt.data.turnNumber === "number" ? receipt.data.turnNumber : 0;
    const claim = this.begin(session, claimedTurn);
    try {
      const interval = NativeIntervalSchema.parse(receipt.data.nativeActivity), turnNumber = z.number().int().positive().parse(receipt.data.turnNumber);
      const semanticTurnId = z.string().parse(receipt.data.semanticTurnId);
      if (!semanticTurnId.startsWith(`${session.provider}:`)) throw new Error("NATIVE_RECEIPT_CONFLICT");
      const providerTurnId = semanticTurnId.slice(session.provider.length + 1), sourceId = this.sourceId(interval, turnNumber);
      const attributed = await this.attribute(session, interval, turnNumber, receipt.cursor, settled);
      if ("deferred" in attributed) return;
      if ("conflict" in attributed) { await this.conflict(session, interval, sourceId); return; }
      const attribution = { ...attributed.attribution, providerTurnId };
      await this.marker(session, interval, sourceId, attribution, attributed.turnParentId);
      const { outstanding, gap } = await this.collect(session, interval, sourceId, attribution);
      await this.recorder.append({ schemaVersion: 1, eventId: activityIdentity(`${sourceId}:turn:completed`), sourceKey: `${sourceId}:turn:completed`,
        ...attribution, parentEventId: attribution.parentEventId!, provider: session.provider,
        observedAt: new Date().toISOString(), occurredAt: z.iso.datetime().parse(receipt.data.providerOccurredAt),
        ...(interval.startedAt ? { startedAt: interval.startedAt } : {}), kind: "provider.turn", operation: "agent", outcome: "succeeded",
        coverage: "complete-for-source", provenance: "provider-native" });
      if (outstanding) await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `${sourceId}:missing-result`,
        ...attribution, provider: session.provider, observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture",
        provenance: "provider-native", coverage: "partial", outcome: "unknown", gap: "missing-result" });
      if (outstanding === 0 && !gap && receipt.data.transport === "provider-native"
        && interval.generation === session.generation && interval.executionId === session.execution?.executionId
        && session.execution?.generation === session.generation && session.executor === "orbstack-container"
        && (session.provider === "claude" || session.provider === "codex")) {
        const source = await this.verifyPairedSource(session, interval, providerTurnId);
        if (source && this.parking.get(session.id) === claim.fact && claim.fact.revision === claim.revision && claim.fact.turn === turnNumber) {
          claim.fact.source = source; claim.fact.complete = true;
        }
      }
    } catch (error) { if (this.parking.get(session.id) === claim.fact) this.invalidate(session.id); throw error; }
    finally { claim.fact.pending--; }
  }

  /** Frames of the turn still running. Best effort: the completed receipt is the authoritative pass. */
  async captureRunning(session: SessionRecord, tail: PendingNativeInterval, turnNumber: number): Promise<void> {
    const key = `${captureIdentity(session)}:${turnNumber}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    const claim = this.begin(session, turnNumber);
    try {
      const pending = NativeIntervalSchema.parse(tail), sourceId = this.sourceId(pending, turnNumber);
      const attributed = await this.attribute(session, pending, turnNumber, undefined, undefined);
      if ("deferred" in attributed) return;
      if ("conflict" in attributed) { await this.conflict(session, pending, sourceId); return; }
      const attribution = { ...attributed.attribution, ...(pending.providerTurnId ? { providerTurnId: pending.providerTurnId } : {}) };
      await this.marker(session, pending, sourceId, attribution, attributed.turnParentId);
      await this.collect(session, pending, sourceId, attribution);
    } catch { /* the completed pass records gaps; a running poll is not evidence of loss */ }
    finally { this.running.delete(key); claim.fact.pending--; }
  }

  private sourceId(interval: NativeInterval, turnNumber: number): string { return `${interval.executionId}:turn:${turnNumber}`; }

  private async attribute(session: SessionRecord, interval: NativeInterval, turnNumber: number, receiptCursor: number | undefined, settled: InstructionRecord | undefined): Promise<Attributed> {
    const parentEventId = activityIdentity(`${this.sourceId(interval, turnNumber)}:turn`);
    const base = { workerId: session.id, sessionId: session.id, generation: interval.generation, executionId: interval.executionId, parentEventId };
    const claims = settled ? [settled] : (await this.instructions.list(session.id)).filter((record) => record.expectedTurn === turnNumber && CLAIMING.has(record.status));
    if (claims.length > 1) return { conflict: true };
    if (claims.length === 1) {
      const record = claims[0]!;
      if (!CONSUMED.has(record.status)) return { deferred: "rendered-only" };
      return { attribution: { ...base, runId: record.workflowRunId ?? record.id, instructionId: record.id, origin: "instruction",
        ...(record.causationId ? { causationId: record.causationId } : {}) }, turnParentId: record.id };
    }
    // No instruction claims this ordinal: the launch prompt or a human prompt appended after the
    // previous turn's receipt. Both are durable thread events with their own identity.
    let previousTurnCursor = 0;
    const prompts: ThreadEvent[] = [];
    for await (const event of this.thread(session.id)) {
      if (event.kind === "turn" && typeof event.data.turnNumber === "number" && event.data.turnNumber < turnNumber) previousTurnCursor = Math.max(previousTurnCursor, event.cursor);
      if (event.kind === "prompt" && event.source === "human") prompts.push(event);
    }
    const window = prompts.filter((event) => event.cursor > previousTurnCursor && (receiptCursor === undefined || event.cursor < receiptCursor));
    const initial = window.find((event) => event.data.initial === true), first = initial ?? window[0];
    const causationId = z.uuid().safeParse(first?.id);
    return { attribution: { ...base, runId: session.id, origin: initial ? "initial-prompt" : first ? "direct-input" : "unattributed",
      ...(causationId.success ? { causationId: causationId.data } : {}) } };
  }

  private async marker(session: SessionRecord, interval: NativeInterval, sourceId: string, attribution: ActivityAttribution, turnParentId: string | undefined): Promise<void> {
    const { parentEventId, ...rest } = attribution;
    await this.recorder.append({ schemaVersion: 1, eventId: parentEventId!, sourceKey: `${sourceId}:turn`, ...rest,
      ...(turnParentId ? { parentEventId: turnParentId } : {}), provider: session.provider, observedAt: new Date().toISOString(),
      ...(interval.startedAt ? { occurredAt: interval.startedAt, startedAt: interval.startedAt } : {}),
      kind: "provider.turn", operation: "agent", outcome: "observed", coverage: "partial", provenance: "provider-native" });
  }

  /** Returns how many invocations still lack a result inside this interval. */
  private async collect(session: SessionRecord, interval: NativeInterval, sourceId: string, attribution: ActivityAttribution): Promise<{ outstanding: number; gap: boolean }> {
    // A running pass may already hold this turn's invocations; their results arrive in a later
    // pass, possibly after restart. Only durable records seed the pairing, never process memory.
    const starts = new Map<string, string | undefined>(), outstanding = new Set<string>();
    let gap = false;
    let after = 0;
    for (;;) {
      const page = await this.recorder.read(attribution.runId, after, 1000);
      for (const event of page) {
        if (event.kind === "capture.gap" && event.sourceKey?.startsWith(sourceId)) gap = true;
        if (event.parentEventId !== attribution.parentEventId && event.kind !== "tool.result") continue;
        if (event.kind === "tool.invocation" && event.toolCallId && event.parentEventId === attribution.parentEventId) { starts.set(event.toolCallId, event.occurredAt); outstanding.add(event.toolCallId); }
        if (event.kind === "tool.result" && event.toolCallId && starts.has(event.toolCallId)) outstanding.delete(event.toolCallId);
      }
      if (page.length < 1000) break;
      after = page.at(-1)!.sequence;
    }
    const parse = session.provider === "claude" ? claudeActivity : codexActivity;
    await this.cursor.collect({ sourceRoot: interval.sourceRoot, path: interval.path, fromOffset: interval.fromOffset, throughOffset: interval.throughOffset,
      sourceId, provider: session.provider, attribution, parse: (raw) => parse(raw).map((frame) => {
        if (frame.kind === "capture.gap" || frame.providerTurnId && attribution.providerTurnId && frame.providerTurnId !== attribution.providerTurnId) gap = true;
        if (frame.toolCallId && frame.kind === "tool.invocation") {
          if (starts.has(frame.toolCallId)) { gap = true; return { kind: "capture.gap", gap: "attribution-conflict" }; }
          starts.set(frame.toolCallId, frame.occurredAt); outstanding.add(frame.toolCallId);
        }
        if (frame.toolCallId && frame.kind === "tool.result") {
          if (!outstanding.delete(frame.toolCallId)) { gap = true; return { kind: "capture.gap", gap: "missing-result" }; }
          const startedAt = starts.get(frame.toolCallId);
          if (startedAt && frame.occurredAt && Date.parse(frame.occurredAt) >= Date.parse(startedAt)) return { ...frame, startedAt };
        }
        return frame;
      }) });
    return { outstanding: outstanding.size, gap };
  }

  /** Re-read the bounded native prefix, not retained activity rows/cursor offsets. Retention
   * cannot erase an unmatched call and fabricate zero. Larger sources remain unknown. */
  private async verifyPairedSource(session: SessionRecord, interval: NativeInterval, providerTurnId: string): Promise<{ path: string; stamp: string } | undefined> {
    if (interval.throughOffset > 16 * 1024 ** 2) return undefined;
    const file = await openContainedSource(interval.sourceRoot, interval.path);
    try {
      const before = await file.stat({ bigint: true });
      if (before.size !== BigInt(interval.throughOffset)) return undefined;
      const calls = new Set<string>(), results = new Set<string>();
      let end = 0, final = false;
      const parse = session.provider === "claude" ? claudeActivity : codexActivity;
      for await (const line of nativeSourceLinesFromFile(file)) {
        end = line.end;
        const raw: unknown = JSON.parse(line.text), frame = object(raw), payload = object(frame?.payload), message = object(frame?.message);
        if (!frame || !(session.provider === "codex" ? ["session_meta", "turn_context", "event_msg", "response_item"]
          : ["user", "assistant", "system", "progress", "file-history-snapshot", "queue-operation"]).includes(String(frame.type))) return undefined;
        if (session.provider === "claude" && Array.isArray(message?.content)
          && message.content.some((block: unknown) => !["text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image"].includes(String(object(block)?.type)))) return undefined;
        for (const parsed of parse(raw)) {
          if (parsed.kind === "capture.gap") return undefined;
          if (parsed.kind === "tool.invocation" && parsed.toolCallId) {
            if (calls.has(parsed.toolCallId)) return undefined; calls.add(parsed.toolCallId);
          }
          if (parsed.kind === "tool.result" && parsed.toolCallId) {
            if (!calls.has(parsed.toolCallId) || results.has(parsed.toolCallId)) return undefined; results.add(parsed.toolCallId);
          }
        }
        final = session.provider === "codex" ? frame?.type === "event_msg" && payload?.type === "task_complete" && payload.turn_id === providerTurnId
          : frame?.type === "assistant" && message?.stop_reason === "end_turn" && message.id === providerTurnId;
      }
      const after = await file.stat({ bigint: true });
      if (end !== interval.throughOffset || !final || calls.size !== results.size || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return undefined;
      const stamp = `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`;
      return fileStamp(interval.path) === stamp ? { path: interval.path, stamp } : undefined;
    } finally { await file.close(); }
  }

  private async conflict(session: SessionRecord, interval: NativeInterval, sourceId: string): Promise<void> {
    await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `${sourceId}:attribution-conflict`, runId: session.id,
      workerId: session.id, sessionId: session.id, generation: interval.generation, executionId: interval.executionId, provider: session.provider,
      observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture", provenance: "broker", coverage: "partial",
      outcome: "unknown", gap: "attribution-conflict" }).catch(() => undefined);
  }

  private async receipt(sessionId: string, turnNumber: number): Promise<ThreadEvent | undefined> {
    const matches: ThreadEvent[] = [];
    for await (const event of this.thread(sessionId)) if (event.kind === "turn" && event.data.turnNumber === turnNumber) matches.push(event);
    if (matches.length > 1) throw new Error("NATIVE_RECEIPT_AMBIGUOUS");
    return matches[0];
  }

  private async *thread(sessionId: string): AsyncGenerator<ThreadEvent> {
    let after = 0;
    for (;;) {
      const page = await this.transcripts.read(sessionId, after, 1000);
      yield* page.events;
      if (page.events.length < 1000) return;
      after = page.nextCursor;
    }
  }
}
