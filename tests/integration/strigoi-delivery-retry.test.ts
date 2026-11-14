import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { successionFixture } from "../orchestration/strigoi-succession-fixture.js";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { StrigoiAdmission } from "../../src/orchestration/strigoi-admission.js";
import { StrigoiDelivery } from "../../src/orchestration/strigoi-delivery.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(["completed", "rendered-declined", "rendered-pressed"] as const)(
  "preserves current queue receipts when native retry admission resumes (%s)", async mode => {
    const f = await successionFixture(true); f.runtime.dispose();
    const admission = new StrigoiAdmission(f.bindings.strigoi, f.bindings, f.registry);
    const queue = new InstructionQueue(f.registry, f.bindings, f.evidence.instructionStore, undefined, admission);
    const delivery = new StrigoiDelivery({ repository: f.bindings.strigoi, bindings: f.bindings, admission,
      registry: f.registry, instructions: queue, workflows: { continuationHolds: async () => [] },
      demand: async () => false, authorizeWorker: async (_actor, _target, apply) => apply() });
    const entered = deferred(), release = deferred(), finished = deferred();
    queue.start();
    try {
      const record = await delivery.submit("Retry must preserve the latest receipt", randomUUID());
      expect(record, JSON.stringify({ record, truth: f.registry.workerTruth(record.targetSessionId), state: await f.bindings.strigoi.read() })).toMatchObject({ status: "rendered", submissionAttempt: { outcome: "unknown" } });
      const initialWrites = f.writes.mock.calls.length;
      const originalAdmission = admission.instruction.bind(admission);
      vi.spyOn(admission, "instruction").mockImplementation(record => async apply => {
        entered.resolve(); await release.promise;
        try { return await originalAdmission(record)(apply); } finally { finished.resolve(); }
      });
      vi.mocked(f.observations.composer).mockReturnValue({ modalOpen: false, occupied: true, inputReady: true, content: record.message });
      await vi.waitFor(() => expect(admission.instruction).toHaveBeenCalled(), { timeout: 5000 });
      await entered.promise;
      if (mode !== "rendered-pressed") {
        vi.mocked(f.observations.composer).mockReturnValue({ modalOpen: false, occupied: false, inputReady: true });
      }
      if (mode === "completed") {
        f.nativeResults.set(record.targetSessionId, [{ providerTurnId: randomUUID(), providerOccurredAt: new Date().toISOString(),
          text: "Native completion while retry waits for admission", transport: "provider-native" }]);
        const result = await f.registry.waitForWorkerResults([{ sessionId: record.targetSessionId, completionTarget: 1 }], 5000);
        expect(result.timedOut).toBe(false);
        await queue.drain();
      }
      const before = (await queue.list())[0]!;
      expect(before.status).toBe(mode === "completed" ? "completed" : "rendered");
      const writes = vi.spyOn(f.evidence.instructionStore, "put");
      release.resolve(); await finished.promise; await queue.drain();
      expect((await queue.list())[0]).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
      expect(f.writes.mock.calls.length).toBe(initialWrites + (mode === "rendered-pressed" ? 1 : 0));
      if (mode === "rendered-pressed") {
        // The same retained admission must also be safe on the verifier's second bounded Enter.
        await vi.waitFor(() => expect(f.writes.mock.calls.length).toBe(initialWrites + 2), { timeout: 5000 });
        expect((await queue.list())[0]).toEqual(before);
        expect(writes).not.toHaveBeenCalled();
      }
    } finally { release.resolve(); queue.stop(); await queue.drain(); await f.close(); vi.restoreAllMocks(); }
  }, 15000,
);
