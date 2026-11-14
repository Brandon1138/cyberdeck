import { effectiveInstruction } from "../../../src/domain/instruction.js";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { StrigoiHold, StrigoiState } from "../../../src/domain/strigoi.js";
import * as privateFiles from "../../../src/persistence/private-files.js";
import { OrchestratorStore } from "../../../src/persistence/orchestrator-store.js";
import { productionFixture } from "./production.js";

export const phases = ["requested", "checkpointing", "sealed", "retiring", "launching", "committed", "adopting", "reconciling", "complete"] as const;
export const faultPoints = ["routine", ...phases.flatMap(p => [`append:before:${p}`, `append:after:${p}`, `fsync:before:${p}`, `fsync:after:${p}`]),
  "effect:checkpoint", "effect:adoption", "effect:retire", "effect:launch", "effect:acknowledge", "effect:delivery", "effect:workers", "effect:attention",
  "intent:stop", "intent:launch", "intent:adoption", "intent:reservation", "intent:checkpoint-complete", "intent:adoption-complete", "three-renewals", "retained-history", "no-checkpoint", "concurrent", "abort", "suspend"];
export interface FaultResult {
  activeCount: number; lostInputs: string[]; duplicateEffects: string[]; holds: StrigoiHold[];
  phase: string | undefined; injected: boolean; diskEqual: boolean; samples: number[];
  expectedHold?: { code: string; sourceIds: string[] }; effectCount: number; checkpointTurns: number; incarnation: number; residentLaunches: number; workerDelivered: number; oldEvidenceRetained: boolean; waitStatus: string | undefined; revokedCapabilityRestored: boolean;
}

/** Faults wrap actual durable/effect boundaries. No state-machine implementation in this harness. */
export async function runStrigoiFaultCase(faultPoint: string): Promise<FaultResult> {
  if (!faultPoints.includes(faultPoint)) throw new Error(`Unknown fault point: ${faultPoint}`);
  const p = await productionFixture(), { f } = p;
  let injected = false;
  const restores: (() => void)[] = [];
  const fail = () => { injected = true; throw new Error("TASK10_INJECTED_LOST_RESPONSE"); };
  const accepted: string[] = [p.seed.messageId];
  const repository = p.evidence.orchestratorStore.strigoi;
  const [kind, side, phase] = faultPoint.split(":");
  const target = (s: StrigoiState) => !!s.transition?.predecessor && (kind === "intent"
    ? side === "stop" ? !!s.transition.stopRequestedAt : side === "launch" ? !!s.transition.launchStartedAt
      : side === "reservation" ? s.transition.phase === "launching" && !!s.transition.successor
      : side === "checkpoint-complete" ? s.transition.checkpointTurn?.outcome === "completed"
      : side === "adoption-complete" ? s.transition.adoptionTurn?.outcome === "completed" : !!s.transition.adoptionTurn
    : s.transition.phase === phase);
  if (kind === "append" || kind === "intent") {
    const original = vi.isMockFunction(repository.compareAndSwap) ? vi.mocked(repository.compareAndSwap).getMockImplementation()! : repository.compareAndSwap.bind(repository);
    const spy = vi.spyOn(repository, "compareAndSwap").mockImplementation(async (...args) => {
      if (!injected && target(args[2])) {
        if (side !== "before") await original(...args);
        return fail();
      }
      return original(...args);
    }); restores.push(() => spy.mockRestore());
  }
  if (kind === "fsync") {
    const original = privateFiles.openPrivateAppendFile;
    const spy = vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementation(async (...args) => {
      const file = await original(...args);
      if (args[0] !== repository.path) return file;
      const write = file.writeFile.bind(file), sync = file.sync.bind(file); let hit = false;
      file.writeFile = async (...data) => { hit = !injected && target(JSON.parse(String(data[0])).state); return write(...data); };
      file.sync = async () => { if (hit && !injected) { if (side === "after") await sync(); fail(); } return sync(); };
      return file;
    }); restores.push(() => spy.mockRestore());
  }
  if (kind === "effect") {
    // Type-preserving wrappers over concrete service methods; each invokes the real effect first.
    if (side === "checkpoint" || side === "adoption") {
      const turns = p.services.runtime.turns, original = turns.submit.bind(turns);
      const spy = vi.spyOn(turns, "submit").mockImplementation(async (...args) => { await original(...args); if (!injected && args[2] === side) fail(); });
      restores.push(() => spy.mockRestore());
    } else if (side === "retire") {
      const original = f.registry.stopResidentProcess.bind(f.registry);
      const spy = vi.spyOn(f.registry, "stopResidentProcess").mockImplementation(async (...args) => { const r = await original(...args); if (!injected) fail(); return r; }); restores.push(() => spy.mockRestore());
    } else if (side === "launch") {
      const original = f.registry.start.bind(f.registry);
      const spy = vi.spyOn(f.registry, "start").mockImplementation(async (...args) => { const r = await original(...args); if (!injected) fail(); return r; }); restores.push(() => spy.mockRestore());
    } else if (side === "acknowledge") {
      const continuity = p.services.runtime.continuity!, original = continuity.acknowledge.bind(continuity);
      const spy = vi.spyOn(continuity, "acknowledge").mockImplementation(async (...args) => { await original(...args); if (!injected) fail(); }); restores.push(() => spy.mockRestore());
    } else if (side === "workers") {
      const workers = p.services.workers, original = workers.recoverResident.bind(workers);
      const spy = vi.spyOn(workers, "recoverResident").mockImplementation(async (...args) => { const r = await original(...args); if (!injected) fail(); return r; }); restores.push(() => spy.mockRestore());
    } else if (side === "attention") {
      const attention = p.services.attention, original = attention.resumeForSuccessor.bind(attention);
      const spy = vi.spyOn(attention, "resumeForSuccessor").mockImplementation(async (...args) => { const r = await original(...args); if (!injected) fail(); return r; }); restores.push(() => spy.mockRestore());
    } else {
      const delivery = p.services.runtime.delivery, original = delivery.reconcile.bind(delivery);
      const spy = vi.spyOn(delivery, "reconcile").mockImplementation(async (...args) => { const r = await original(...args); if (!injected) fail(); return r; }); restores.push(() => spy.mockRestore());
    }
  }
  try {
    if (faultPoint === "retained-history") for (let n = 0; n < 70; n++) {
      await p.evidence.sources.record("turn", `old-retained-${n}`, { occurredAt: "2020-01-01T00:00:00.000Z",
        text: `Retained original constraint ${n}: review only, approval outstanding` }, [p.seed.targetSessionId]);
    }
    if (faultPoint === "no-checkpoint") {
      // Exact-generation confirmed process loss, with persisted original input and no packet.
      f.emitExit(); await vi.waitFor(async () => { if (await f.registry.residentRetirement(p.seed.targetSessionId, 1) !== "confirmed") throw new Error("retirement pending"); });
      await p.reopen();
    }
    let transitionId: string | undefined;
    try {
      const t = faultPoint === "no-checkpoint" ? (await repository.read()).transition! : await p.services.runtime.succession!.renew(1, "acceptance", "task10-renew"); transitionId = t.id;
      const gapId = randomUUID(); accepted.push(gapId);
      await p.services.runtime.delivery.submit("Input during cutover retains original constraint", gapId);
      await p.respond(p.worker.id, "Entrusted result with original evidence", 1);
      if (faultPoint === "concurrent") {
        const wait = (await p.evidence.attentionStore.get(p.controller.controllerId))!;
        await Promise.all([
          p.services.attention.cancel({ actorSessionId: p.seed.targetSessionId, epoch: wait.epoch }),
          p.evidence.orchestratorStore.withAuthority(async () => {
            const s = await repository.read();
            await repository.compareAndSwap(s.revision, "concurrent-grant", { ...s, revision: s.revision + 1,
              activeBinding: { ...s.activeBinding!, grant: { ...s.activeBinding!.grant, capabilities: s.activeBinding!.grant.capabilities.filter(c => c !== "orchestrator.create") } } });
          }),
          p.services.runtime.delivery.submit("Input during cutover retains original constraint", gapId),
          p.services.runtime.succession!.advance(t.id),
        ]);
      } else if (faultPoint === "abort") await p.services.runtime.succession!.abort(t.id, "abort");
      else if (faultPoint === "suspend") await p.services.runtime.lifecycle.setDesired("suspended", "suspend");
      else await p.drive(t.id);
    } catch (error) {
      if (!injected || !/TASK10_INJECTED|sync failed/.test(String(error))) throw error;
    }
    restores.splice(0).forEach(restore => restore());
    if (faultPoint !== "no-checkpoint") await p.reopen();
    let s = await p.evidence.orchestratorStore.strigoi.read();
    transitionId ??= (await p.services.runtime.succession!.renew(1, "acceptance", "task10-renew")).id;
    // Pending inputs accepted before the requested record failed must still be exercised.
    if (accepted.length === 1 && faultPoint !== "suspend") {
      const id = randomUUID(); accepted.push(id); await p.services.runtime.delivery.submit("Recovered cutover input", id);
      await p.respond(p.worker.id, "Recovered worker result", 1);
    }
    const needsTimeout = faultPoint === "intent:adoption" || faultPoint === "append:after:checkpointing" || kind === "fsync" && phase === "checkpointing";
    const clock = needsTimeout ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_001) : undefined;
    try { s = await p.drive(transitionId); } finally { clock?.mockRestore(); }
    if (faultPoint === "three-renewals") for (let n = 0; n < 2; n++) {
      for (const record of await p.services.instructions.list()) if (accepted.includes(record.messageId) && record.status === "rendered") {
        const target = effectiveInstruction(record).targetSessionId;
        await p.respond(target, "Constraint and rationale retained; waiting for approval", record.expectedTurn!);
        await p.services.instructions.flush(target);
      }
      const t = await p.services.runtime.succession!.renew(s.incarnation, "acceptance", `repeat-${n}`); s = await p.drive(t.id);
      await p.reopen();
    }
    const held = s.hold ? [s.hold] : [];
    const expectedCode = faultPoint === "append:after:checkpointing" || faultPoint.startsWith("fsync:") && phase === "checkpointing"
      ? "checkpoint-outcome-unresolved" : faultPoint === "intent:launch" ? "launch-ownership-unresolved"
      : faultPoint === "intent:adoption" ? "adoption-outcome-unresolved" : faultPoint === "intent:stop" ? "retirement-unconfirmed" : undefined;
    if (!held.length && faultPoint !== "suspend") {
      await f.registry.detach(p.worker.id, "fixture-operator"); await p.services.instructions.flush(p.worker.id);
    }
    const records = await p.services.instructions.list();
    const lostInputs = accepted.filter(id => !records.some(r => r.messageId === id));
    // A durable queue is enough only for an explicit hold/suspension. Routine continuation must render.
    if (!held.length && faultPoint !== "suspend") for (const id of accepted) {
      if (!records.some(r => r.messageId === id && ["rendered", "completed"].includes(r.status))) lostInputs.push(`undelivered:${id}`);
    }
    const counts = new Map<string, number>(); for (const e of p.effects) counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
    const disk = await new OrchestratorStore(f.root).strigoi.read();
    let oldEvidenceRetained = false, cursor: string | undefined;
    if (s.latestPacket ?? s.transition?.packet) do {
      const page = await p.evidence.packets.read((s.latestPacket ?? s.transition!.packet)! , cursor);
      oldEvidenceRetained ||= page.sources.some(source => source.text?.includes("ORIGINAL_RATIONALE")); cursor = page.nextCursor;
    } while (cursor);
    const wait = await p.evidence.attentionStore.get(p.controller.controllerId);
    return { activeCount: f.activeHighWater, samples: f.activeSamples, lostInputs,
      duplicateEffects: [...counts].filter(([, n]) => n > 1).map(([id]) => id), holds: held,
      workerDelivered: p.effects.filter(e => e.text === p.outgoing.message).length, oldEvidenceRetained, waitStatus: wait?.status,
      revokedCapabilityRestored: faultPoint === "concurrent" && !!s.activeBinding?.grant.capabilities.includes("orchestrator.create"),
      phase: s.transition?.phase, injected, diskEqual: JSON.stringify(disk) === JSON.stringify(s), effectCount: p.effects.length, checkpointTurns: p.effects.filter(e => e.kind === "checkpoint").length, incarnation: s.incarnation, residentLaunches: f.spawn.mock.calls.length - 1,
      ...(expectedCode ? { expectedHold: { code: expectedCode, sourceIds: [s.transition!.predecessor!.sessionId, ...s.transition!.successor ? [s.transition!.successor.sessionId] : []] } } : {}) };
  } finally { restores.forEach(restore => restore()); await p.close(); }
}
