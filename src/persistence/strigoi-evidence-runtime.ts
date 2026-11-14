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
  let held = false;
  const instructionStore = new InstructionStore(stateDirectory, (record) => held ? Promise.resolve() : sources.record("instruction", record.id, record,
    [record.actorSessionId, record.targetSessionId, ...record.senderSessionId ? [record.senderSessionId] : []]));
  const workflowStore = new WorkflowStore(stateDirectory, (record) => held ? Promise.resolve() : sources.record("workflow", record.id, record,
    "ownerSessionId" in record ? [record.ownerSessionId, ...record.participantSessionIds] : [record.fromSessionId, record.toSessionId]));
  const attentionStore = new OrchestratorAttentionStore(stateDirectory, undefined, (record) => held ? Promise.resolve() : sources.record("attention", record.epoch, record,
    [record.actorSessionId, ...record.statement.targets.map((t) => t.sessionId)]));
  sources = new StrigoiSources({ repository: orchestratorStore.strigoi, archive, instructions: instructionStore,
    workflows: workflowStore, attention: attentionStore, coordination: new WorkerCoordinationStore(stateDirectory) });
  const beforeDelete = async (id: string) => {
    if (held || await sources.relevant([id]) || (await archive.pins()).has(id)) throw new Error("STRIGOI_EVIDENCE_REFERENCED");
  };
  const transcriptContinuity: NonNullable<ThreadTranscriptStoreOptions["continuity"]> = {
    event: (event) => held ? Promise.resolve() : sources.event(event), beforeDelete,
    native: (id, sourceId, message) => held ? Promise.resolve() : sources.record("turn", `native:${id}:${sourceId}`, message, [id]),
  };
  async function verify() {
    await orchestratorStore.strigoi.retentionPins();
    await packets.verify(await archive.list());
    const state = await orchestratorStore.strigoi.read();
    const protectedSessionIds = new Set([...await orchestratorStore.strigoi.retentionPins(), ...await archive.pins()]);
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
    sources.attach(transcripts, () => sessions.load());
    try {
      const pins = await orchestratorStore.strigoi.retentionPins();
      // Validate the index even with no current active resident; historical evidence remains pinned.
      await archive.pins();
      const state = await orchestratorStore.strigoi.read();
      await packets.verify(await sources.capture(state));
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
  return { orchestratorStore, artifactStore, instructionStore, workflowStore, attentionStore, packets, sources, archive, transcriptContinuity, beforeDelete, startup, verify: async () => { await verify(); } };
}
