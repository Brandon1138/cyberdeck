import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../src/persistence/artifact-store.js";
import { StrigoiPackets } from "../../src/persistence/strigoi-packets.js";
import { StrigoiContinuity } from "../../src/orchestration/strigoi-continuity.js";
import { withBindingAuthority } from "../../src/persistence/binding-authority.js";
import { at, deferred, fixture, identity } from "../orchestration/strigoi-admission-fixture.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function memoryArtifacts() {
  const records = new Map<string, { content: Buffer; logicalKind: string | undefined }>(), reads = new Map<string, number>();
  const artifacts = {
    write: async (request: { content: string; logicalKind?: string }) => {
      const id = randomUUID(); records.set(id, { content: Buffer.from(request.content), logicalKind: request.logicalKind });
      return { descriptor: { id } };
    },
    read: async (id: string) => {
      const record = records.get(id); if (!record) throw new Error("missing artifact");
      reads.set(record.logicalKind!, (reads.get(record.logicalKind!) ?? 0) + 1); return record;
    },
  } as unknown as ArtifactStore;
  return { artifacts, reads };
}

it.each([64, 256, 1024])("traverses %s sources with one inventory read per page across reader reconstruction", async count => {
  const { artifacts, reads } = memoryArtifacts(), packets = new StrigoiPackets(artifacts), sources = [];
  for (let i = 0; i < count; i++) sources.push(...await packets.copy({ kind: "turn", id: `original-${i}`, revision: "1" }, `original ${i}`, [identity.sessionId]));
  const ref = await packets.write(identity, "", sources, at); reads.clear();
  let cursor: string | undefined, pages = 0, seen = 0;
  do {
    const page = await new StrigoiPackets(artifacts).read(ref, cursor);
    seen += page.sources.length; pages++; cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toBe(count); expect(pages).toBe(count / 64);
  expect(reads.get("strigoi-inventory")).toBe(pages);
  expect(reads.get("strigoi-page-index") ?? 0).toBeLessThanOrEqual(2 * pages - 1);
  expect(reads.get("strigoi-source")).toBe(count);
});

it.each((["checkpoint", "read", "acknowledge"] as const).flatMap(operation =>
  (["generation", "state", "grant"] as const).map(change => ({ operation, change }))))(
  "$operation validates immutable evidence without blocking unrelated authority ($change)", async ({ operation, change }) => {
  const directory = await mkdtemp(join(tmpdir(), "strigoi-contention-")); roots.push(directory);
  const f = fixture(), { artifacts } = memoryArtifacts(), packets = new StrigoiPackets(artifacts);
  const sources = await packets.copy({ kind: "turn", id: "constraint", revision: "1" }, "Never publish", [identity.sessionId]);
  const repository = { ...f.repository, compareAndSwap: async (revision: number, _id: string, next: ReturnType<typeof f.state>) => {
    expect(revision).toBe(f.state().revision); f.set(next); return next;
  } };
  const authority = <T>(work: () => Promise<T>) => withBindingAuthority(directory, work);
  const service = new StrigoiContinuity({ repository, packets, admission: f.admission, bindings: { withAuthority: authority }, sources: { capture: async () => sources } });
  const packet = await service.checkpoint(identity, "Intent", [], "first");
  const entered = deferred(), release = deferred();
  if (operation === "checkpoint") {
    const write = packets.write.bind(packets);
    vi.spyOn(packets, "write").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return write(...args); });
  } else {
    const read = packets.read.bind(packets);
    vi.spyOn(packets, "read").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return read(...args); });
  }
  let authorized = true;
  const authorize = async () => { if (!authorized) throw new Error("CAPABILITY_DENIED"); };
  const work = operation === "checkpoint" ? service.checkpoint(identity, "Updated", [], "second", authorize)
    : operation === "read" ? service.read(identity, packet, undefined, authorize)
      : service.acknowledge({ identity, packetHash: packet.sha256, coverageId: packet.coverageId, handledSourceIds: [sources[0]!.coverageSourceId!], account: "Preserve intent" }, "adopt", authorize);
  const result = work.then(value => value, (error: unknown) => error);
  await entered.promise;
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([authority(async () => {}), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("immutable evidence holds global authority")), 1000); })]);
    // The final boundary must still reject changed identity after this off-lock work.
    if (change === "generation") f.set({ ...f.state(), activeGeneration: 2 });
    if (change === "state") f.set(operation === "read" ? { ...f.state(), latestPacket: undefined, continuityReceipts: [] } : { ...f.state(), desired: "suspended" });
    if (change === "grant") authorized = false;
  } finally { clearTimeout(timer!); release.resolve(); await result; }
  expect(await result).toMatchObject({ message: change === "generation" ? "STRIGOI_STALE_INCARNATION"
    : change === "state" ? operation === "read" ? "STRIGOI_UNKNOWN_PACKET" : "STRIGOI_SUSPENDED" : change === "grant" ? "CAPABILITY_DENIED" : "STRIGOI_STALE_INCARNATION" });
  expect(f.state().continuityReceipts).toHaveLength(change === "state" && operation === "read" ? 0 : 1);
});
