import { createHash } from "node:crypto";
import type { AgentActivity } from "../domain/agent-activity.js";
import type { TaskEvaluationIntent } from "../domain/task-evaluation.js";
import { evidenceHash, type TaskEvaluationOutboxPort, type EvaluationEvidenceManifest } from "./task-evaluation-ports.js";

export interface TaskEvaluationEvidencePort {
  /** Read only host-owned immutable artifacts. Missing artifacts return incomplete evidence.
   * Must use the terminal event's historical generation, never the current session generation. */
  capture(event: AgentActivity): Promise<{ generation: number; manifest: EvaluationEvidenceManifest }>;
}
/** Called after canonical fsync. Exceptions leave the canonical source pending for replay;
 * callers must expose backpressure and retain source journals until reconciliation succeeds. */
export class TaskEvaluationService {
  constructor(private readonly store: TaskEvaluationOutboxPort, private readonly evidence: TaskEvaluationEvidencePort,
    private readonly rubric: { id: string; version: string }) {}
  async observeTerminal(event: AgentActivity): Promise<void> {
    if (event.provenance === "worker-report") return;
    const instruction = ["instruction.settled", "instruction.cancelled", "instruction.undelivered"].includes(event.kind);
    const turn = event.kind === "provider.turn" && ["succeeded", "failed", "cancelled"].includes(event.outcome) && !event.instructionId;
    const execution = event.kind === "execution.lifecycle" && ["failed", "cancelled"].includes(event.outcome) && !event.instructionId;
    if (!instruction && !turn && !execution) return;
    const { generation, manifest } = await this.evidence.capture(event);
    if (!Number.isSafeInteger(generation) || generation < 1 || (event.generation !== undefined && generation !== event.generation)) throw new Error("EVALUATION_GENERATION_UNKNOWN");
    const identity = instruction ? `instruction:${event.instructionId ?? event.eventId}` : `event:${event.eventId}`;
    const attemptId = createHash("sha256").update(JSON.stringify([event.sessionId, generation, identity])).digest("hex");
    const intent: TaskEvaluationIntent = { attemptId, sessionId: event.sessionId, generation,
      ...(event.executionId ? { executionId: event.executionId } : {}), ...(event.instructionId ? { instructionId: event.instructionId } : {}),
      attribution: instruction ? "instruction" : event.origin ?? "unattributed", rubricId: this.rubric.id,
      rubricVersion: this.rubric.version, evidenceManifestHash: evidenceHash(manifest) };
    this.store.enqueue(intent, manifest);
  }
  async reconcile(events: AsyncIterable<AgentActivity>): Promise<{ observed: number }> {
    let observed = 0;
    for await (const event of events) { await this.observeTerminal(event); observed++; }
    return { observed };
  }
}
