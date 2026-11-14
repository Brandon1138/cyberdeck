import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { productionFixture } from "../fixtures/strigoi/production.js";
import { retainEvidenceReferences } from "../../src/persistence/strigoi-evidence-deletion.js";

// Opt-in measurement, separate from correctness assertions and never a benchmark threshold.
it.skipIf(!process.env.STRIGOI_MEASURE_OUTPUT)("measures retained inventories and unrelated binding delay", async () => {
  const p = await productionFixture(), rows: unknown[] = [];
  try {
    const { resident: _resident, ...ordinary } = p.f.original.activeBinding!;
    const ordinaryId = randomUUID();
    const binding = { ...ordinary, kind: "peer" as const, key: `fleet:peer:${ordinaryId}`, sessionId: ordinaryId,
      grant: { ...ordinary.grant, subjectSessionId: ordinaryId } };
    await p.evidence.orchestratorStore.put(binding);
    let prior = 0;
    for (const count of [64, 256, 1024]) {
      const captureStart = performance.now();
      for (let n = prior; n < count; n++) {
        const retained = randomUUID();
        await retainEvidenceReferences(p.f.root, [retained]);
        await p.evidence.archive.capture("turn", `synthetic-${n}`, { role: "user", text: "Synthetic retained original evidence. ".repeat(8), ordinal: n }, [retained]);
      }
      const captureMs = performance.now() - captureStart; prior = count;
      const state = await p.evidence.orchestratorStore.strigoi.read();
      const identity = { sessionId: state.activeBinding!.sessionId, incarnation: state.incarnation, generation: state.activeGeneration! };
      const refs = await p.evidence.archive.list();
      const writeStart = performance.now();
      const packet = await p.services.runtime.continuity!.checkpoint(identity, "Synthetic scaling checkpoint; no inference", [], `scale-${count}`);
      const checkpointMs = performance.now() - writeStart;
      const walkStart = performance.now(); let cursor: string | undefined, pages = 0, sources = 0;
      const handled: string[] = [];
      do {
        const page = await p.evidence.packets.read(packet, cursor); pages++; sources += page.sources.length;
        handled.push(...page.sources.map(s => s.coverageSourceId!)); cursor = page.nextCursor;
      } while (cursor);
      const traversalMs = performance.now() - walkStart;
      expect(sources).toBeGreaterThanOrEqual(count);
      const baselineStart = performance.now(); await p.evidence.orchestratorStore.put(binding); const unrelatedBaselineMs = performance.now() - baselineStart;
      let enter!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      // This sibling is created outside acknowledge's binding-authority async context.
      const unrelated = (async () => { await entered; const start = performance.now();
        await p.evidence.orchestratorStore.put({ ...binding, updatedAt: new Date().toISOString() }); return performance.now() - start; })();
      const read = p.evidence.packets.read.bind(p.evidence.packets);
      const spy = vi.spyOn(p.evidence.packets, "read").mockImplementation(async (...args) => { enter(); return read(...args); });
      const acknowledgeStart = performance.now();
      await p.services.runtime.continuity!.acknowledge({ identity, packetHash: packet.sha256, coverageId: packet.coverageId,
        handledSourceIds: handled, account: "Synthetic mechanical read, no semantic claim" }, `scale-ack-${count}`);
      const acknowledgementMs = performance.now() - acknowledgeStart;
      const unrelatedBlockedMs = await unrelated; spy.mockRestore();
      rows.push({ retainedSyntheticRecords: count, archiveReferencesBeforeCheckpoint: refs.length, packetSources: sources, pages,
        captureMs, checkpointMs, traversalMs, acknowledgementMs, unrelatedBaselineMs, unrelatedBlockedMs,
        indexBytes: (await stat(p.evidence.archive.path)).size, rssBytes: process.memoryUsage().rss });
    }
    await writeFile(process.env.STRIGOI_MEASURE_OUTPUT!, JSON.stringify({ node: process.version, inventories: [64, 256, 1024], synthetic: true,
      samplesPerInventory: 1, limitation: "Single warm-process local sample; no production failure threshold or asymptotic qualification", rows }, null, 2));
  } finally { await p.close(); }
}, 240000);
