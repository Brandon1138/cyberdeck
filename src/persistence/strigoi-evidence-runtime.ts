import { StrigoiStoreError } from "./strigoi-store.js";
import { StrigoiArchiveError } from "./strigoi-archive-error.js";
import { effectiveInstruction, type InstructionRecord } from "../domain/instruction.js";
import { StrigoiTurnEvidence } from "./strigoi-turn-evidence.js";
import { indexedInstructionReceipt } from "./instruction-target-index.js";
import { instructionSessionIds } from "../domain/instruction.js";
import { syncPrivateFile } from "./atomic-private-file.js";
import { withEvidenceDeletion, withEvidenceReferences, retainEvidenceReferences, evidenceSafety, reconcileEvidenceDeletions, type EvidenceReferenceGuard } from "./strigoi-evidence-deletion.js";
import { randomUUID } from "node:crypto";
import { ArtifactStore } from "./artifact-store.js";
import { OrchestratorStore } from "./orchestrator-store.js";
import { InstructionStore } from "./instruction-store.js";
import { WorkflowStore } from "./workflow-store.js";
import { WorkerCoordinationStore } from "./worker-coordination-store.js";
import { OrchestratorAttentionStore } from "./orchestrator-attention-store.js";
import { StrigoiPackets } from "./strigoi-packets.js";
import { StrigoiSourceArchive } from "./strigoi-source-archive.js";
import { StrigoiSources } from "./strigoi-sources.js";
import type { ThreadTranscriptStore, ThreadTranscriptStoreOptions } from "./thread-transcript-store.js";
import type { SessionStore } from "./session-store.js";

/** Composition-only collaborator, created before any startup retention or session restoration. */
export function composeStrigoiEvidence(stateDirectory: string) {
  const orchestratorStore = new OrchestratorStore(stateDirectory), artifactStore = new ArtifactStore(stateDirectory);
  const packets = new StrigoiPackets(artifactStore), archive = new StrigoiSourceArchive(stateDirectory, packets);
  let sources: StrigoiSources;
  let turnTranscripts: ThreadTranscriptStore | undefined;
  let held = false;
  // Corruption can appear after startup. Disable only resident evidence capture;
  // canonical ordinary records still commit, with conservative durable pins. Never
  // swallow arbitrary I/O/publication failures or resident/ordinary identity conflicts.
  const isolateResidentCorruption = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof StrigoiArchiveError) && (!(error instanceof StrigoiStoreError) || error.code !== "STRIGOI_CORRUPT_STATE")) throw error;
      held = true;
      if (error instanceof StrigoiArchiveError) await orchestratorStore.withAuthority(async () => {
        const state = await orchestratorStore.strigoi.read();
        if (state.hold) return;
        await orchestratorStore.strigoi.compareAndSwap(state.revision, `archive-hold:${randomUUID()}`, { ...state,
          revision: state.revision + 1, updatedAt: new Date().toISOString(),
          hold: { code: "continuity-evidence-unavailable", detail: String(error), sourceIds: [] } });
      });
      return fallback;
    }
  };
  const capture = (work: () => Promise<void>) => held ? Promise.resolve() : isolateResidentCorruption(work, undefined);
  const withReferences: EvidenceReferenceGuard = (ids, commit) => withEvidenceReferences(stateDirectory, ids, async () => {
    if (ids.length && (held || await isolateResidentCorruption(() => sources.relevant([...ids]), true))) await retainEvidenceReferences(stateDirectory, ids);
    return commit();
  });
  const instructionStore = new InstructionStore(stateDirectory, (record) => capture(() => sources.record("instruction", record.id, record,
    instructionSessionIds(record))), withReferences);
  const workflowStore = new WorkflowStore(stateDirectory, (record) => capture(() => sources.record("workflow", record.id, record,
    "ownerSessionId" in record ? [record.ownerSessionId, ...record.participantSessionIds] : [record.fromSessionId, record.toSessionId])), withReferences);
  const attentionStore = new OrchestratorAttentionStore(stateDirectory, undefined, (record) => capture(() => sources.record("attention", record.epoch, record,
    [record.actorSessionId, ...record.statement.targets.map((t) => t.sessionId)])), withReferences);
  sources = new StrigoiSources({ repository: orchestratorStore.strigoi, archive, instructions: instructionStore,
    workflows: workflowStore, attention: attentionStore, coordination: new WorkerCoordinationStore(stateDirectory) });
  const beforeDelete = async (id: string) => {
    if (held || await sources.relevant([id]) || (await archive.pins()).has(id)) throw new Error("STRIGOI_EVIDENCE_REFERENCED");
  };
  const withDeletion = <T>(id: string, commit: () => Promise<T>) => withEvidenceDeletion(stateDirectory, id, () => beforeDelete(id), commit);
  const transcriptContinuity: NonNullable<ThreadTranscriptStoreOptions["continuity"]> = {
    event: (event) => orchestratorStore.withAuthority(async () => {
      if (held || await isolateResidentCorruption(() => sources.relevant([event.sessionId]), true)) {
        await withReferences([event.sessionId], () => capture(() => sources.event(event)));
      }
    }), beforeDelete,
    // Explicit verify/recovery must still recapture repaired native evidence while held.
    native: (id, sourceId, message) => isolateResidentCorruption(() => sources.record("turn", `native:${id}:${sourceId}`, message, [id]), undefined),
  };
  async function verify() {
    await orchestratorStore.strigoi.retentionPins();
    const state = await orchestratorStore.strigoi.read();
    await packets.verify(await sources.capture(state));
    await packets.verify(await archive.list());
    await archive.confirm();
    const protectedSessionIds = new Set([...await orchestratorStore.strigoi.retentionPins(), ...await archive.pins(),
      ...(await evidenceSafety(stateDirectory)).deletions.map((d) => d.sessionId)]);
    for (const packet of [state.latestPacket, state.transition?.packet, ...state.continuityReceipts?.map((r) => r.packet) ?? []]) {
      if (!packet) continue;
      let cursor: string | undefined;
      do {
        const page = await packets.read(packet, cursor);
        for (const source of page.sources) for (const id of source.sessionIds ?? []) protectedSessionIds.add(id);
        cursor = page.nextCursor;
      } while (cursor);
    }
    held = false;
    return protectedSessionIds;
  }
  async function startup(transcripts: ThreadTranscriptStore, sessions: SessionStore) {
    turnTranscripts = transcripts;
    sources.attach(transcripts, () => sessions.load());
    try {
      const interrupted = await reconcileEvidenceDeletions(stateDirectory, new Set((await sessions.load()).map((s) => s.id)), () => syncPrivateFile(sessions.path));
      if (interrupted.size) console.error("Strigoi evidence: interrupted session deletions remain fenced for explicit retry", [...interrupted]);
      const pins = await orchestratorStore.strigoi.retentionPins();
      // Validate the index even with no current active resident; historical evidence remains pinned.
      await archive.pins();
      return { protectedSessionIds: new Set([...pins, ...await verify()]), skipDestructiveRetention: false };
    } catch (error) {
      held = true;
      // A corrupt authority shard itself already reports a resident hold on every read.
      await orchestratorStore.withAuthority(async () => {
        const state = await orchestratorStore.strigoi.read();
        await orchestratorStore.strigoi.compareAndSwap(state.revision, `retention-hold:${randomUUID()}`, { ...state,
          revision: state.revision + 1, updatedAt: new Date().toISOString(),
          hold: { code: "continuity-evidence-unavailable", detail: String(error), sourceIds: [] } });
      }).catch(() => undefined);
      console.error("Strigoi continuity held; startup retention skipped", error);
      return { protectedSessionIds: new Set<string>(), skipDestructiveRetention: true };
    }
  }
  const access = new StrigoiTurnEvidence({ repository: orchestratorStore.strigoi, packets, sources, artifacts: artifactStore });
  const observeInstruction = async (record: InstructionRecord) => {
    if (!turnTranscripts) throw new Error("STRIGOI_TRANSCRIPTS_UNAVAILABLE");
    return indexedInstructionReceipt(record, await turnTranscripts.readCompletionLedger(effectiveInstruction(record).targetSessionId));
  };
  return { turnPrompt: access.prompt.bind(access), observeInstruction, orchestratorStore, artifactStore, instructionStore, workflowStore, attentionStore, packets, sources, archive, transcriptContinuity, beforeDelete, withDeletion, startup, verify: async () => { await verify(); } };
}
