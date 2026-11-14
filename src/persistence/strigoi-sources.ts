import type { StrigoiState, StrigoiSourceRef } from "../domain/strigoi.js";
import { instructionSessionIds } from "../domain/instruction.js";
import type { SessionRecord } from "../domain/session.js";
import type { ThreadEvent } from "../domain/thread.js";
import { orchestratorController } from "../domain/orchestrator.js";
import type { StrigoiRepository, StrigoiSourcePort } from "../orchestration/strigoi-ports.js";
import type { InstructionStore } from "./instruction-store.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { OrchestratorAttentionStore } from "./orchestrator-attention-store.js";
import type { WorkerCoordinationStore } from "./worker-coordination-store.js";
import type { ThreadTranscriptStore } from "./thread-transcript-store.js";
import { nativeSourceFailure } from "./native-source-observation.js";
import type { StrigoiSourceArchive } from "./strigoi-source-archive.js";

export interface StrigoiSourcesOptions {
  repository: StrigoiRepository; archive: StrigoiSourceArchive; instructions: InstructionStore;
  workflows: WorkflowStore; attention: OrchestratorAttentionStore; coordination: WorkerCoordinationStore;
}
/** Reads existing ownership/evidence interfaces; never creates a second mailbox or authority. */
export class StrigoiSources implements StrigoiSourcePort {
  private transcripts: ThreadTranscriptStore | undefined;
  private sessions: (() => Promise<SessionRecord[]>) | undefined;
  constructor(private readonly options: StrigoiSourcesOptions) {}
  attach(transcripts: ThreadTranscriptStore, sessions: () => Promise<SessionRecord[]>) { this.transcripts = transcripts; this.sessions = sessions; }
  async relevant(ids: string[]): Promise<boolean> {
    const pins = await this.options.repository.retentionPins();
    if (!pins.size) return false;
    const captured = await this.options.archive.pins();
    if (ids.some((id) => pins.has(id) || captured.has(id))) return true;
    const state = await this.options.repository.read();
    if (!state.activeBinding) return false;
    const controller = orchestratorController(state.activeBinding).controllerId;
    return (await this.options.coordination.load()).subjects.some((s) => ids.includes(s.resources.sessionId ?? "")
      && (s.lease.controller?.controllerId === controller || s.origin.creatorControllerId === controller));
  }
  async event(event: ThreadEvent): Promise<void> {
    if (await this.relevant([event.sessionId])) await this.options.archive.capture(event.kind === "instruction" ? "instruction" : "turn", `thread:${event.id}`, event, [event.sessionId]);
  }
  async record(kind: StrigoiSourceRef["kind"], id: string, value: unknown, ids: string[]): Promise<void> {
    if (await this.relevant(ids)) await this.options.archive.capture(kind, id, value, ids);
  }
  async capture(state: StrigoiState): Promise<StrigoiSourceRef[]> {
    const { repository, archive, instructions, workflows, attention, coordination } = this.options;
    const residentIds = new Set(await repository.retentionPins());
    if (residentIds.size === 0) return [];
    const ids = new Set([...residentIds, ...await archive.pins()]);
    const controller = state.activeBinding ? orchestratorController(state.activeBinding).controllerId : undefined;
    const coordinated = await coordination.load();
    const subjects = coordinated.subjects.filter((s) => ids.has(s.resources.sessionId ?? "")
      || residentIds.has(s.origin.creatorSessionId ?? "") || (controller !== undefined && (s.origin.creatorControllerId === controller || s.lease.controller?.controllerId === controller))
      || coordinated.audits.some((a) => a.subjectId === s.subjectId && controller !== undefined && [a.actor.controllerId, a.priorController?.controllerId, a.newController?.controllerId].includes(controller)));
    for (const subject of subjects) {
      if (subject.resources.sessionId) ids.add(subject.resources.sessionId);
      await archive.capture("worker-event", `ownership:${subject.subjectId}`, subject, subject.resources.sessionId ? [subject.resources.sessionId] : []);
    }
    for (const record of await instructions.list()) {
      const sessionIds = instructionSessionIds(record);
      if (!sessionIds.some((id) => ids.has(id))) continue;
      sessionIds.forEach((id) => ids.add(id));
      await archive.capture("instruction", record.id, record, sessionIds);
    }
    for (const event of coordinated.events) {
      if (subjects.some((s) => s.subjectId === event.workerId)) await archive.capture("worker-event", `event:${event.workerId}:${event.eventId}`, event,
        subjects.filter((s) => s.subjectId === event.workerId).flatMap((s) => s.resources.sessionId ? [s.resources.sessionId] : []));
    }
    for (const wait of await attention.list()) {
      if (!ids.has(wait.actorSessionId)) continue;
      const sessionIds = [wait.actorSessionId, ...wait.statement.targets.map((t) => t.sessionId)];
      sessionIds.forEach((id) => ids.add(id)); await archive.capture("attention", wait.epoch, wait, sessionIds);
    }
    for (const run of await workflows.listRuns()) {
      if (![run.ownerSessionId, ...run.participantSessionIds].some((id) => ids.has(id))) continue;
      const sessionIds = [run.ownerSessionId, ...run.participantSessionIds]; sessionIds.forEach((id) => ids.add(id));
      await archive.capture("workflow", run.id, run, sessionIds);
      for (const message of await workflows.listMessages(run.id)) await archive.capture("workflow", message.id, message, [message.fromSessionId, message.toSessionId]);
    }
    for (const session of await this.sessions?.() ?? []) {
      if (!ids.has(session.id)) continue;
      // Session launch prompt and identity survive even abrupt loss before a first model packet.
      await archive.capture("artifact", `session:${session.id}`, session, [session.id]);
      let cursor = 0;
      while (this.transcripts) {
        const page = await this.transcripts.read(session.id, cursor, 1000);
        for (const event of page.events) await archive.capture(event.kind === "instruction" ? "instruction" : "turn", `thread:${event.id}`, event, [session.id]);
        if (page.nextCursor <= cursor || !page.events.length) break; cursor = page.nextCursor;
      }
      try {
        await this.transcripts?.captureOriginalContext({ sessionId: session.id, provider: session.provider, cwd: session.cwd,
          createdAt: session.createdAt, turnNumber: 0 }, session);
      } catch (error) {
        const copied = (await archive.list()).some((s) => s.id.startsWith(`native:${session.id}:`));
        if (nativeSourceFailure(error).status !== "missing" || !copied) throw error;
      }
    }
    return archive.list();
  }
}
