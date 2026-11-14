import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ArtifactStore } from "../../src/persistence/artifact-store.js";
import { StrigoiPackets } from "../../src/persistence/strigoi-packets.js";
import { StrigoiTurnEvidence } from "../../src/persistence/strigoi-turn-evidence.js";
import { StrigoiStore } from "../../src/persistence/strigoi-store.js";

it("provides all native adoption evidence through bounded linked private pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "strigoi-native-pages-"));
  try {
    const artifacts = new ArtifactStore(root), packets = new StrigoiPackets(artifacts);
    const identity = { sessionId: randomUUID(), incarnation: 1, generation: 1 };
    const refs: import("../../src/domain/strigoi.js").StrigoiSourceRef[] = [];
    for (let i = 0; i < 66; i++) refs.push(...await packets.copy({ kind: "instruction", id: `instruction:${i}`, revision: "1" }, `Original obligation ${i}`, [identity.sessionId]));
    const long = "é".repeat(20000);
    refs.push(...await packets.copy({ kind: "turn", id: "long-original", revision: "1" }, long, [identity.sessionId]));
    const packet = await packets.write(identity, "All original obligations", refs, new Date().toISOString());
    const evidence = new StrigoiTurnEvidence({ repository: new StrigoiStore(root), packets, artifacts, sources: { capture: async () => refs } });
    const prompt = await evidence.prompt("adoption", identity, packet);
    let next: string | undefined = JSON.parse(prompt.match(/page at ("[^"\n]+")./)![1]!);
    const seen: string[] = [], collected = []; let pages = 0;
    while (next) {
      expect(seen).not.toContain(next); seen.push(next);
      const page = JSON.parse(await readFile(next, "utf8"));
      expect(page.sources.length).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(page.sources.map((s: { text: string }) => s.text).join(""))).toBeLessThanOrEqual(32768);
      collected.push(...page.sources); next = page.nextPath; pages++;
    }
    expect(pages).toBeGreaterThan(2); expect(collected.map(s => s.coverageSourceId).sort()).toEqual(refs.map(s => s.coverageSourceId).sort());
    expect(collected.filter(s => s.id === "long-original").sort((a, b) => a.part - b.part).map(s => s.text).join("")).toBe(long);
    expect(Buffer.byteLength(prompt)).toBeLessThan(4096);
  } finally { await rm(root, { recursive: true, force: true }); }
});
