import { activityIdentity } from "./provider-activity-collector.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InstructionRecord } from "../../domain/instruction.js";
import type { SessionRecord } from "../../domain/session.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import type { ThreadReadResult } from "../../domain/thread.js";
import { NativeActivityCursor } from "./native-activity-cursor.js";
import { claudeActivity } from "./claude-activity.js";
import { codexActivity } from "./codex-activity.js";

const Interval = z.object({ sourceRoot: z.string(), path: z.string(), fromOffset: z.number().int().nonnegative(), throughOffset: z.number().int().positive(), generation: z.number().int().positive(), executionId: z.uuid(), startedAt: z.iso.datetime().optional() }).strict();
/** Matches durable expectedTurn to a durable semantic receipt. No nearest-time inference. */
export class InstructionNativeCapture {
  private readonly cursor: NativeActivityCursor;
  constructor(directory: string, private readonly recorder: AgentActivityPort,
    private readonly transcripts: { read(id: string, after?: number, limit?: number): Promise<ThreadReadResult> },
  ) { this.cursor = new NativeActivityCursor(directory, recorder); }
  async capture(record: InstructionRecord, session: SessionRecord | undefined): Promise<void> {
    if (record.status !== "completed") return;
    try {
      if (session?.executor !== "orbstack-container" || !record.expectedTurn || !session.generation) throw new Error("NATIVE_CAPTURE_UNAVAILABLE");
      let after = 0;
      const matches = [];
      for (;;) {
        const page = await this.transcripts.read(record.targetSessionId, after, 1000);
        matches.push(...page.events.filter((event) => event.kind === "turn" && event.data.turnNumber === record.expectedTurn));
        if (page.events.length < 1000) break;
        after = page.nextCursor;
      }
      if (matches.length !== 1 || matches[0]!.data.transport !== "provider-native") throw new Error("NATIVE_RECEIPT_AMBIGUOUS");
      const receipt = matches[0]!, interval = Interval.parse(receipt.data.nativeActivity);
      const semanticTurnId = z.string().parse(receipt.data.semanticTurnId);
      if (!semanticTurnId.startsWith(`${session.provider}:`)) throw new Error("NATIVE_RECEIPT_CONFLICT");
      const providerTurnId = semanticTurnId.slice(session.provider.length + 1);
      const sourceId = `${interval.executionId}:${semanticTurnId}`, parentEventId = activityIdentity(`${sourceId}:turn`);
      await this.recorder.append({ schemaVersion: 1, eventId: parentEventId, sourceKey: `${sourceId}:turn`,
        runId: record.workflowRunId ?? record.id, instructionId: record.id, workerId: session.id, sessionId: session.id,
        generation: interval.generation, executionId: interval.executionId, parentEventId: record.id, providerTurnId,
        provider: session.provider, observedAt: new Date().toISOString(), occurredAt: z.iso.datetime().parse(receipt.data.providerOccurredAt),
        ...(interval.startedAt ? { startedAt: interval.startedAt } : {}), kind: "provider.turn", operation: "agent", outcome: "observed",
        coverage: "complete-for-source", provenance: "provider-native" });
      const starts = new Map<string, string | undefined>(), outstanding = new Set<string>();
      const parse = session.provider === "claude" ? claudeActivity : codexActivity;
      await this.cursor.collect({ ...interval, sourceId,
        provider: session.provider, parse: (raw) => parse(raw).map((frame) => {
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
        }),
        attribution: { runId: record.workflowRunId ?? record.id, instructionId: record.id,
          sessionId: session.id, workerId: session.id, generation: interval.generation, providerTurnId, parentEventId,
          executionId: interval.executionId } });
      if (outstanding.size) await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `${sourceId}:missing-result`,
        runId: record.workflowRunId ?? record.id, instructionId: record.id, workerId: session.id, sessionId: session.id, parentEventId,
        observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture", provenance: "provider-native",
        coverage: "partial", outcome: "unknown", gap: "missing-result" });
    } catch {
      await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `native-capture-failed:${record.id}`,
        runId: record.workflowRunId ?? record.id, instructionId: record.id, sessionId: record.targetSessionId, workerId: record.targetSessionId,
        observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture", provenance: "broker",
        coverage: "unavailable", outcome: "unknown", gap: "unsupported-source" }).catch(() => undefined);
    }
  }
}
