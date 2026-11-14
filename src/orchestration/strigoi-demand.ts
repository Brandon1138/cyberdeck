import { orchestratorController } from "../domain/orchestrator.js";
import type { OwnershipSubject } from "../domain/worker-coordination.js";
import type { OrchestratorAttention } from "../domain/orchestrator-attention.js";
import type { StrigoiIdentity } from "../domain/strigoi.js";
import type { ThreadTranscriptReader } from "./persistence-ports.js";
import type { StrigoiRepository } from "./strigoi-ports.js";

/** Current journals, not historical packet volume, decide whether passive recovery needs inference. */
export class StrigoiDemand {
  constructor(private readonly o: { repository: StrigoiRepository; transcripts: ThreadTranscriptReader;
    subjects(): OwnershipSubject[]; waits(): Promise<OrchestratorAttention[]>;
    completionTurns(sessionId: string): Promise<number> }) {}
  async evidence(identity: StrigoiIdentity): Promise<string[]> {
    const s = await this.o.repository.read();
    if (s.activeBinding?.sessionId !== identity.sessionId || s.activeGeneration !== identity.generation) throw new Error("STRIGOI_STALE_INCARNATION");
    const ids = await this.o.repository.retentionPins(), controller = orchestratorController(s.activeBinding).controllerId;
    const waits = (await this.o.waits()).filter(w => w.controllerId === controller);
    const evidence = waits.filter(w => w.status === "armed").map(w => `attention:${w.epoch}`);
    for (const worker of this.o.subjects()) {
      if (worker.lease.controller?.controllerId !== controller || worker.lease.state === "released") continue;
      if (worker.lifecycle !== "done") { evidence.push(`worker:${worker.subjectId}:${worker.lease.version}`); continue; }
      // A completed result is actionable until the existing attention service records consumption.
      const consumed = Math.max(0, ...waits.flatMap(w => w.coverage.consumed.filter(p => p.sessionId === worker.resources.sessionId).map(p => p.completionTurn)));
      const completed = await this.o.completionTurns(worker.resources.sessionId ?? worker.subjectId);
      if (completed > consumed) evidence.push(`result:${worker.subjectId}:${completed}`);
    }
    for (const id of ids) {
      let cursor = 0, pending: string | undefined;
      for (;;) {
        const page = await this.o.transcripts.read(id, cursor, 100);
        if (page.fragment || page.continuation) throw new Error("STRIGOI_DEMAND_EVIDENCE_INCOMPLETE");
        for (const event of page.events) {
          if (event.kind === "prompt" && event.source === "human") pending = event.id;
          if (event.kind === "turn" && event.data.transport === "provider-native") pending = undefined;
        }
        if (!page.events.length || page.nextCursor <= cursor) break;
        cursor = page.nextCursor;
      }
      if (pending) evidence.push(`conversation:${id}:${pending}`);
    }
    return evidence;
  }
}
