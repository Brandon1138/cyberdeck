import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StrigoiContinuity } from "../../src/orchestration/strigoi-continuity.js";
import { ArtifactStore } from "../../src/persistence/artifact-store.js";
import { StrigoiPackets } from "../../src/persistence/strigoi-packets.js";
import { fixture, identity } from "./strigoi-admission-fixture.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function setup() {
  const f = fixture(), dir = await mkdtemp(join(tmpdir(), "strigoi-continuity-")); directories.push(dir);
  const packets = new StrigoiPackets(new ArtifactStore(dir));
  const sources = await packets.copy({ kind: "turn", id: "original-operator", revision: "1" }, "Do not publish", [identity.sessionId]);
  const repository = { ...f.repository, compareAndSwap: async (revision: number, _id: string, next: ReturnType<typeof f.state>) => {
    expect(revision).toBe(f.state().revision); f.set(next); return next;
  } };
  const continuity = new StrigoiContinuity({ repository, admission: f.admission, bindings: { withAuthority: async <T>(work: () => Promise<T>) => work() }, packets,
    sources: { capture: async () => structuredClone(sources) } });
  return { f, packets, sources, continuity };
}
it("includes omitted original instructions, leaves later results pending, and replays mutations", async () => {
  const { f, packets, sources, continuity } = await setup();
  const ref = await continuity.checkpoint(identity, "Plan", [], "checkpoint-a");
  expect((await continuity.read(identity, ref)).sources[0]!.text).toBe("Do not publish");
  sources.push(...await packets.copy({ kind: "worker-event", id: "late-result", revision: "1" }, "Done", [identity.sessionId]));
  expect(await continuity.checkpoint(identity, "Plan", [], "checkpoint-a")).toEqual(ref);
  const adoption = { identity, packetHash: ref.sha256, coverageId: ref.coverageId, handledSourceIds: [sources[0]!.coverageSourceId!], account: "Keep the constraint; inspect the result next." };
  await continuity.acknowledge(adoption, "ack-a"); const revision = f.state().revision;
  await continuity.acknowledge(adoption, "ack-a"); expect(f.state().revision).toBe(revision);
  expect(await continuity.pending(identity)).toEqual([sources[1]]);
  await expect(continuity.acknowledge({ ...adoption, handledSourceIds: [sources[1]!.coverageSourceId!] }, "bad")).rejects.toThrow();
  await expect(continuity.checkpoint(identity, "Changed", [], "checkpoint-a")).rejects.toThrow();
});
it("rejects stale generations, unknown requests and malformed acknowledgements", async () => {
  const { continuity } = await setup();
  await expect(continuity.checkpoint({ ...identity, generation: 2 }, "x", [], "stale")).rejects.toThrow();
  await expect(continuity.checkpoint(identity, "x", [{ kind: "turn", id: "invented", revision: "1" }], "invented")).rejects.toThrow();
  const ref = await continuity.checkpoint(identity, "x", [], "ok");
  await expect(continuity.acknowledge({ identity, packetHash: ref.sha256, coverageId: ref.coverageId, handledSourceIds: [], account: "" }, "bad")).rejects.toThrow();
});

it("treats supplied references only as inclusion requests and rejects duplicate/unknown handled IDs", async () => {
  const { sources, continuity } = await setup();
  const ref = await continuity.checkpoint(identity, "", [{ ...sources[0]!, coverageSourceId: "f".repeat(64) }], "include");
  expect(await continuity.pending(identity)).toEqual(sources);
  for (const ids of [["e".repeat(64)], [sources[0]!.coverageSourceId!, sources[0]!.coverageSourceId!]]) {
    await expect(continuity.acknowledge({ identity, packetHash: ref.sha256, coverageId: ref.coverageId, handledSourceIds: ids, account: "Read" }, "invalid")).rejects.toThrow();
  }
});
it("captures outside authority, rechecks identity after capture, and never commits a failed packet", async () => {
  const { f, packets, sources } = await setup(); let locked = false;
  const compareAndSwap = vi.fn(async (_r: number, _m: string, next: ReturnType<typeof f.state>) => { f.set(next); return next; });
  const capture = vi.fn(async () => { expect(locked).toBe(false); return sources; });
  const service = new StrigoiContinuity({ repository: { ...f.repository, compareAndSwap }, admission: f.admission, packets,
    sources: { capture }, bindings: { withAuthority: async <T>(work: () => Promise<T>) => { expect(locked).toBe(false); locked = true; try { return await work(); } finally { locked = false; } } } });
  vi.spyOn(packets, "write").mockRejectedValueOnce(new Error("artifact unavailable"));
  await expect(service.checkpoint(identity, "", [], "fail")).rejects.toThrow("artifact unavailable"); expect(compareAndSwap).not.toHaveBeenCalled();
  capture.mockImplementationOnce(async () => { f.set({ ...f.state(), activeGeneration: 2 }); return sources; });
  await expect(service.checkpoint(identity, "", [], "stale")).rejects.toThrow("STRIGOI_STALE_INCARNATION"); expect(compareAndSwap).not.toHaveBeenCalled();
});
it("allows exact recovery acknowledgements while frozen but never after suspension", async () => {
  const { f, sources, continuity } = await setup();
  const packet = await continuity.checkpoint(identity, "Intent", [], "cp");
  await f.admission.freeze(identity);
  const adoption = { identity, packetHash: packet.sha256, coverageId: packet.coverageId, handledSourceIds: [sources[0]!.coverageSourceId!], account: "Read" };
  await continuity.acknowledge(adoption, "adopt");
  await expect(continuity.checkpoint(identity, "New", [], "new")).rejects.toThrow("STRIGOI_FROZEN");
  f.set({ ...f.state(), desired: "suspended" });
  await expect(continuity.acknowledge(adoption, "other")).rejects.toThrow("STRIGOI_SUSPENDED");
});
