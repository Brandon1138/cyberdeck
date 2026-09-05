import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { InstructionRecord } from "../../domain/instruction.js";
import type { SessionRecord } from "../../domain/session.js";
import type { AgentActivityPort } from "../../orchestration/agent-activity-port.js";
import type { ThreadReadResult } from "../../domain/thread.js";
import { NativeActivityCursor } from "./native-activity-cursor.js";
import { claudeActivity } from "./claude-activity.js";
import { codexActivity } from "./codex-activity.js";

const Interval = z.object({ sourceRoot: z.string(), path: z.string(), fromOffset: z.number().int().nonnegative(), throughOffset: z.number().int().positive(), generation: z.number().int().positive(), executionId: z.uuid() }).strict();
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
      await this.cursor.collect({ ...interval, sourceId: `${interval.executionId}:${semanticTurnId}`,
        provider: session.provider, parse: session.provider === "claude" ? claudeActivity : codexActivity,
        attribution: { runId: record.workflowRunId ?? record.id, instructionId: record.id,
          sessionId: session.id, workerId: session.id, generation: interval.generation, providerTurnId,
          executionId: interval.executionId } });
    } catch {
      await this.recorder.append({ schemaVersion: 1, eventId: randomUUID(), sourceKey: `native-capture-failed:${record.id}`,
        runId: record.workflowRunId ?? record.id, instructionId: record.id, sessionId: record.targetSessionId, workerId: record.targetSessionId,
        observedAt: new Date().toISOString(), kind: "capture.gap", operation: "capture", provenance: "broker",
        coverage: "unavailable", outcome: "unknown", gap: "unsupported-source" }).catch(() => undefined);
    }
  }
}
