import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InstructionRecord } from "../../domain/instruction.js";
import type { SessionRecord } from "../../domain/session.js";
import type { ThreadEvent, ThreadReadResult } from "../../domain/thread.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import { claudeActivity } from "./claude-activity.js";
import { codexActivity } from "./codex-activity.js";
import { NativeActivityCursor } from "./native-activity-cursor.js";
import type { PendingNativeInterval } from "./container-native-source.js";
import { activityIdentity, type ActivityAttribution } from "./provider-activity-collector.js";

export const NativeIntervalSchema = z.object({ sourceRoot: z.string(), path: z.string(), fromOffset: z.number().int().nonnegative(),
  throughOffset: z.number().int().positive(), generation: z.number().int().positive(), executionId: z.uuid(),
  startedAt: z.iso.datetime().optional(), providerTurnId: z.string().optional() }).strict();
export type NativeInterval = z.infer<typeof NativeIntervalSchema>;

interface Transcripts { read(id: string, after?: number, limit?: number): Promise<ThreadReadResult> }
interface Instructions { list(targetSessionId?: string): Promise<InstructionRecord[]> }
type Attributed = { attribution: ActivityAttribution; turnParentId?: string } | { deferred: "rendered-only" } | { conflict: true };

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
  constructor(directory: string, private readonly recorder: AgentActivityPort,
    private readonly transcripts: Transcripts, private readonly instructions: Instructions,
  ) { this.cursor = new NativeActivityCursor(directory, recorder); }

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
      await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `native-capture-failed:${record.id}`,
        runId: record.workflowRunId ?? record.id, instructionId: record.id, sessionId: record.targetSessionId, workerId: record.targetSessionId,
        observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture", provenance: "broker",
        coverage: "unavailable", outcome: "unknown", gap: "unsupported-source" }).catch(() => undefined);
    }
  }

  /** A durable semantic receipt names an exact interval; capture it under the identity that dispatched it. */
  async captureCompleted(session: SessionRecord, receipt: ThreadEvent, settled?: InstructionRecord): Promise<void> {
    const interval = NativeIntervalSchema.parse(receipt.data.nativeActivity), turnNumber = z.number().int().positive().parse(receipt.data.turnNumber);
    const semanticTurnId = z.string().parse(receipt.data.semanticTurnId);
    if (!semanticTurnId.startsWith(`${session.provider}:`)) throw new Error("NATIVE_RECEIPT_CONFLICT");
    const providerTurnId = semanticTurnId.slice(session.provider.length + 1), sourceId = this.sourceId(interval, turnNumber);
    const attributed = await this.attribute(session, interval, turnNumber, receipt.cursor, settled);
    if ("deferred" in attributed) return;
    if ("conflict" in attributed) { await this.conflict(session, interval, sourceId); return; }
    const attribution = { ...attributed.attribution, providerTurnId };
    await this.marker(session, interval, sourceId, attribution, attributed.turnParentId);
    const outstanding = await this.collect(session, interval, sourceId, attribution);
    await this.recorder.append({ schemaVersion: 1, eventId: activityIdentity(`${sourceId}:turn:completed`), sourceKey: `${sourceId}:turn:completed`,
      ...attribution, parentEventId: attribution.parentEventId!, provider: session.provider,
      observedAt: new Date().toISOString(), occurredAt: z.iso.datetime().parse(receipt.data.providerOccurredAt),
      ...(interval.startedAt ? { startedAt: interval.startedAt } : {}), kind: "provider.turn", operation: "agent", outcome: "succeeded",
      coverage: "complete-for-source", provenance: "provider-native" });
    if (outstanding) await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `${sourceId}:missing-result`,
      ...attribution, provider: session.provider, observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture",
      provenance: "provider-native", coverage: "partial", outcome: "unknown", gap: "missing-result" });
  }

  /** Frames of the turn still running. Best effort: the completed receipt is the authoritative pass. */
  async captureRunning(session: SessionRecord, tail: PendingNativeInterval, turnNumber: number): Promise<void> {
    const key = `${session.id}:${turnNumber}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      const pending = NativeIntervalSchema.parse(tail), sourceId = this.sourceId(pending, turnNumber);
      const attributed = await this.attribute(session, pending, turnNumber, undefined, undefined);
      if ("deferred" in attributed) return;
      if ("conflict" in attributed) { await this.conflict(session, pending, sourceId); return; }
      const attribution = { ...attributed.attribution, ...(pending.providerTurnId ? { providerTurnId: pending.providerTurnId } : {}) };
      await this.marker(session, pending, sourceId, attribution, attributed.turnParentId);
      await this.collect(session, pending, sourceId, attribution);
    } catch { /* the completed pass records gaps; a running poll is not evidence of loss */ }
    finally { this.running.delete(key); }
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
  private async collect(session: SessionRecord, interval: NativeInterval, sourceId: string, attribution: ActivityAttribution): Promise<number> {
    // A running pass may already hold this turn's invocations; their results arrive in a later
    // pass, possibly after restart. Only durable records seed the pairing, never process memory.
    const starts = new Map<string, string | undefined>(), outstanding = new Set<string>();
    let after = 0;
    for (;;) {
      const page = await this.recorder.read(attribution.runId, after, 1000);
      for (const event of page) {
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
        if (frame.toolCallId && frame.kind === "tool.invocation") {
          if (starts.has(frame.toolCallId)) return { kind: "capture.gap", gap: "attribution-conflict" };
          starts.set(frame.toolCallId, frame.occurredAt); outstanding.add(frame.toolCallId);
        }
        if (frame.toolCallId && frame.kind === "tool.result") {
          if (!outstanding.delete(frame.toolCallId)) return { kind: "capture.gap", gap: "missing-result" };
          const startedAt = starts.get(frame.toolCallId);
          if (startedAt && frame.occurredAt && Date.parse(frame.occurredAt) >= Date.parse(startedAt)) return { ...frame, startedAt };
        }
        return frame;
      }) });
    return outstanding.size;
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
