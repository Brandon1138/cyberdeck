import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ArtifactStore } from "../../src/persistence/artifact-store.js";
import { StrigoiPackets } from "../../src/persistence/strigoi-packets.js";
import { identity, at } from "../orchestration/strigoi-admission-fixture.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "strigoi-packets-")); directories.push(dir);
  const artifacts = new ArtifactStore(dir); return { dir, artifacts, packets: new StrigoiPackets(artifacts) };
}
it("keeps original source text in private artifacts and pages UTF-8 without truncation", async () => {
  const { packets } = await fixture();
  const original = "ș😀".repeat(18000);
  const sources = await packets.copy({ kind: "turn", id: "original", revision: "1" }, original, [identity.sessionId]);
  const ref = await packets.write(identity, "understanding", sources, at);
  let cursor: string | undefined, text = "", count = 0;
  do {
    const page = await packets.read(ref, cursor);
    expect(page.sources.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(page.sources.map((s) => s.text ?? "").join(""))).toBeLessThanOrEqual(32768);
    text += page.sources.map((s) => s.text ?? "").join(""); count += page.sources.length; cursor = page.nextCursor;
  } while (cursor);
  expect(count).toBeGreaterThan(1); expect(text).toBe(original);
});
it("rejects oversized UTF-8 prose and validates packet and source hashes", async () => {
  const { packets, artifacts } = await fixture();
  await expect(packets.write(identity, "é".repeat(16385), [], at)).rejects.toThrow();
  const sources = await packets.copy({ kind: "turn", id: "x", revision: "1" }, "original", [identity.sessionId]);
  const ref = await packets.write(identity, "é".repeat(16384), sources, at);
  await expect(packets.read({ ...ref, sha256: "a".repeat(64) })).rejects.toThrow();
  const source = await artifacts.read(sources[0]!.copy!.artifactId);
  if (source.descriptor.content.kind !== "file") throw new Error("expected private file");
  await writeFile(source.descriptor.content.path, "tampered");
  await expect(packets.read(ref)).rejects.toThrow();
  const manifest = await artifacts.read(ref.artifactId);
  if (manifest.descriptor.content.kind !== "file") throw new Error("expected private file");
  await writeFile(manifest.descriptor.content.path, (await readFile(manifest.descriptor.content.path, "utf8")).replace("coverageId", "corruptKey"));
  await expect(packets.read(ref)).rejects.toThrow();
});

it("paginates more than 64 source references and refuses foreign or malformed cursors", async () => {
  const { packets } = await fixture();
  const sources = [];
  for (let i = 0; i < 130; i++) sources.push(...await packets.copy({ kind: "instruction", id: `instruction-${i}`, revision: "1" }, `original ${i}`, [identity.sessionId]));
  const ref = await packets.write(identity, "", sources, at), first = await packets.read(ref);
  expect(first.sources).toHaveLength(64);
  const second = await packets.read(ref, first.nextCursor); expect(second.sources).toHaveLength(64);
  const third = await packets.read(ref, second.nextCursor); expect(third.sources).toHaveLength(2); expect(third.nextCursor).toBeUndefined();
  const other = await packets.write(identity, "Other", sources, at);
  await expect(packets.read(other, first.nextCursor)).rejects.toThrow("STRIGOI_INVALID_CURSOR");
  for (const cursor of ["0", `${ref.sha256}:-1`, `${ref.sha256}:1x`, `${ref.sha256}:999999999999999999999`]) await expect(packets.read(ref, cursor)).rejects.toThrow();
});
it("refuses a manifest beyond 256 KiB and missing source fragments", async () => {
  const { packets, artifacts } = await fixture();
  const source = await packets.copy({ kind: "turn", id: "long", revision: "1" }, "x".repeat(40000), [identity.sessionId]);
  await expect(packets.write(identity, "", source.slice(1), at)).rejects.toThrow("STRIGOI_SOURCE_PART_MISSING");
  const stored = await artifacts.write({ name: "oversized.json", mediaType: "application/json", content: " ".repeat(256 * 1024 + 1) });
  await expect(packets.read({ artifactId: stored.descriptor.id, sha256: stored.descriptor.digest!.slice(7), coverageId: "coverage" })).rejects.toThrow("STRIGOI_MANIFEST_TOO_LARGE");
});
