import type { SessionRegistry } from "../../broker/session-registry.js";
import type { WorkerCoordinationService } from "../../broker/worker-coordination.js";
import type { InstructionQueue } from "../../orchestration/instruction-queue.js";
import type { InstructionParkingReadModel } from "../../orchestration/instruction-parking-read-model.js";
import { RuntimeParkingService, type RuntimeParkingPort } from "../../orchestration/runtime-parking-service.js";
import { RuntimeParkingStore } from "../../persistence/runtime-parking-store.js";
import type { ExecutionTranscriptStore } from "../../persistence/execution-transcript-store.js";

export async function brokerParkingRuntime(options: {
  directory: string; assertOwner(): void; registry: SessionRegistry; transcripts: ExecutionTranscriptStore;
  coordination: Pick<WorkerCoordinationService, "getSubject">; instructions: InstructionQueue;
  instructionFacts: InstructionParkingReadModel; inFlightReports(id: string): number;
  idleGraceMs: number; maxWakeAttempts: number;
}) {
  let failures = 0, closing = false;
  const pending = new Map<string, Promise<unknown>>();
  const store = await RuntimeParkingStore.open(options.directory, options.assertOwner, {
    isRetired: id => !options.registry.list().some(record => record.id === id),
  });
  let service: RuntimeParkingService;
  const observe = (id: string, task: Promise<unknown>) => {
    pending.set(id, task); void task.catch(() => { failures++; }).finally(() => { if (pending.get(id) === task) pending.delete(id); });
  };
  const wake = (id: string) => { if (!closing) observe(id, service.inputQueued(id)); };
  const port = options.registry.createParkingPort({
    facts: id => {
      const truth = options.registry.workerTruth(id), native = options.transcripts.parkingFacts(id, truth.completedTurns);
      const instructions = options.instructionFacts.read(id), lease = options.coordination.getSubject(id)?.lease;
      // Controller/epoch is copied from the sole canonical lease; it grants nothing here.
      const validLease = lease?.controller && ["active", "contested"].includes(lease.state) && Date.parse(lease.expiresAt) > Date.now();
      return { ...native, authorityEpoch: JSON.stringify(lease ? [lease.controller, lease.version, lease.state] : ["unbound"]),
        instructions: instructions.statuses, resumeSupported: native.resumeSupported && Boolean(validLease),
        outstandingTools: instructions.known ? native.outstandingTools : null,
        pendingReports: instructions.known ? options.inFlightReports(id) : null };
    }, onInputQueued: wake, flush: async id => { await options.instructions.flush(id); },
  });
  const wrapped: RuntimeParkingPort = {
    snapshot: id => port.snapshot(id), claim: expected => port.claim(expected), release: claim => port.release(claim),
    restoreParked: expected => port.restoreParked(expected), stop: claim => port.stop(claim), awaitStopped: claim => port.awaitStopped(claim),
    flush: id => port.flush(id), resume: async claim => {
      await port.resume(claim);
      const deadline = Date.now() + 10000;
      do {
        await options.transcripts.refreshParkingFacts(claim.expected.sessionId);
        const current = port.snapshot(claim.expected.sessionId);
        if (current.conversationId === claim.expected.conversationId || closing) return current;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      return port.snapshot(claim.expected.sessionId);
    },
  };
  service = new RuntimeParkingService(wrapped, store, { idleGraceMs: options.idleGraceMs, maxWakeAttempts: options.maxWakeAttempts });
  for (const record of store.list()) {
    if (record.phase === "active") continue;
    try {
      await options.transcripts.refreshParkingFacts(record.sessionId);
      const current = port.snapshot(record.sessionId);
      // Unknown conversation evidence must not turn retained queued input into terminal failure.
      if (current.runtime === "stopped" && current.generation === record.identity.generation && current.executionId === record.identity.executionId)
        port.restoreParked(current);
      await service.recover(record.sessionId, false); // Never block broker status on queued capacity.
    } catch { failures++; }
  }
  options.instructionFacts.bindWake(wake);
  let sweep: Promise<void> | undefined, cursor = 0;
  const timer = setInterval(() => {
    if (sweep || closing) return;
    sweep = (async () => {
      const records = options.registry.list();
      const eligible = records.filter(record => record.kind !== "orchestrator" && record.executor === "orbstack-container" && !pending.has(record.id));
      const batch = Array.from({ length: Math.min(64, eligible.length) }, (_, index) => eligible[(cursor + index) % eligible.length]!);
      cursor = eligible.length ? (cursor + batch.length) % eligible.length : 0;
      for (const record of batch) {
        await options.transcripts.refreshParkingFacts(record.id);
        const parked = store.get(record.id), instruction = options.instructionFacts.read(record.id);
        if (parked?.phase === "parked" && instruction.known && instruction.statuses.some(s => !["completed", "cancelled", "undelivered"].includes(s))) wake(record.id);
        else observe(record.id, service.consider(record.id));
      }
      options.instructionFacts.reconcileRetired(new Set(records.map(record => record.id)));
      for (const retained of store.list()) if (!records.some(r => r.id === retained.sessionId) && !pending.has(retained.sessionId)) {
        service.forget(retained.sessionId); options.instructionFacts.forget(retained.sessionId);
        if (retained.phase === "active") await store.retire(retained.sessionId, retained.identity.generation);
      }
    })().catch(() => { failures++; }).finally(() => { sweep = undefined; });
  }, 5000).unref();
  return { service,
    health: () => ({ failures, pending: pending.size, records: store.list().map(r => ({ sessionId: r.sessionId, generation: r.identity.generation, phase: r.phase, reason: r.reason })) }),
    close: async () => { closing = true; clearInterval(timer); await sweep; await Promise.allSettled([...pending.values()]); },
  };
}
