import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as atomic from "../../src/persistence/atomic-private-file.js";
import * as privateFiles from "../../src/persistence/private-files.js";
import { ArtifactStore } from "../../src/persistence/artifact-store.js";
import { StrigoiPackets } from "../../src/persistence/strigoi-packets.js";
import { StrigoiSourceArchive } from "../../src/persistence/strigoi-source-archive.js";
import { identity } from "../orchestration/strigoi-admission-fixture.js";
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "strigoi-index-")); roots.push(root);
  const packets = new StrigoiPackets(new ArtifactStore(root)), archive = new StrigoiSourceArchive(root, packets);
  const capture = (id = "original") => archive.capture("turn", id, "Retained original", [identity.sessionId]);
  return { root, packets, archive, capture, journal: `${archive.path}l` };
}

it("persists 64/256/1024 captures with incremental writes and full post-append validation", async () => {
  const f = await fixture(); const write = atomic.writeAtomicPrivateFile, open = fs.open;
  let journalReplays = 0;
  const writes: Array<{ path: string; bytes: number }> = [];
  vi.spyOn(atomic, "writeAtomicPrivateFile").mockImplementation(async (path, body) => { writes.push({ path, bytes: Buffer.byteLength(body) }); await write(path, body); });
  vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (path === f.journal && flags === "r") {
      const read = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementation((...args: unknown[]) => { journalReplays++; return (read as (...args: unknown[]) => ReturnType<typeof read>)(...args); });
    }
    return handle;
  });
  for (let n = 0; n < 1024; n++) {
    await f.capture(`original-${n}`);
    if ([64, 256, 1024].includes(n + 1)) {
      expect(await f.archive.list()).toHaveLength(n + 1);
      expect(writes.filter(w => w.path === f.archive.path)).toHaveLength(1);
      expect(writes.filter(w => w.path === f.journal)).toHaveLength(1); // initial empty journal only
      expect(writes.filter(w => w.path.endsWith(".head")).every(w => w.bytes < 128)).toBe(true);
      // Each append is validated from disk; initialization creates no projection.
      // Intervening unchanged loads reuse validation, never inferred append history.
      expect(journalReplays).toBe(n + 1);
    }
  }
  const reopened = new StrigoiSourceArchive(f.root, f.packets);
  expect(await reopened.list()).toHaveLength(1024);
  expect((await reopened.pins()).has(identity.sessionId)).toBe(true);
}, 120000);

it.each(["journal-missing", "head-missing", "journal-marker-missing", "base-marker-missing", "torn", "truncate", "rewrite"])("fences initialized %s and permits explicit restoration/reverification", async damage => {
  const f = await fixture(); await f.capture("first"); await f.capture("second");
  const original = await readFile(f.journal, "utf8"), head = await readFile(`${f.journal}.head`, "utf8");
  const baseMarker = await readFile(`${f.archive.path}.initialized`, "utf8");
  if (damage === "journal-missing") await rm(f.journal);
  if (damage === "head-missing") await rm(`${f.journal}.head`);
  if (damage === "journal-marker-missing") await rm(`${f.journal}.initialized`);
  if (damage === "base-marker-missing") await rm(`${f.archive.path}.initialized`);
  if (damage === "torn") await writeFile(f.journal, original.slice(0, -1));
  if (damage === "truncate") await writeFile(f.journal, original.split("\n")[0] + "\n");
  if (damage === "rewrite") await writeFile(f.journal, original.replace("first", "other"));
  await expect(f.archive.list()).rejects.toThrow("STRIGOI_");
  await expect(f.capture("later")).rejects.toThrow("STRIGOI_");
  await writeFile(f.journal, original); await writeFile(`${f.journal}.head`, head);
  await writeFile(`${f.journal}.initialized`, "1\n"); await writeFile(`${f.archive.path}.initialized`, baseMarker);
  expect(await f.archive.list()).toHaveLength(2);
  await f.packets.verify(await f.archive.list());
});

it.each(["append-sync", "append-close", "head-sync"])("propagates %s ambiguity and confirms visible records before retry success", async failure => {
  const f = await fixture(); await f.capture("first");
  const oldHead = await readFile(`${f.journal}.head`, "utf8");
  const append = privateFiles.openPrivateAppendFile, write = atomic.writeAtomicPrivateFile;
  const appendSpy = vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementation(async path => {
    const file = await append(path);
    if (failure === "append-sync" && path === f.journal) vi.spyOn(file, "sync").mockRejectedValueOnce(new Error("index fsync uncertain"));
    if (failure === "append-close" && path === f.journal) {
      const close = file.close.bind(file);
      vi.spyOn(file, "close").mockImplementationOnce(async () => { await close(); throw new Error("index fsync uncertain"); });
    }
    return file;
  });
  const headSpy = vi.spyOn(atomic, "writeAtomicPrivateFile").mockImplementation(async (path, body) => {
    await write(path, body); if (failure === "head-sync" && path === `${f.journal}.head`) throw new Error("index fsync uncertain");
  });
  await expect(f.capture("second")).rejects.toThrow("index fsync uncertain");
  if (failure !== "head-sync") expect(await readFile(`${f.journal}.head`, "utf8")).toBe(oldHead);
  appendSpy.mockRestore(); headSpy.mockRestore();
  expect(await f.archive.list()).toHaveLength(2); // conservative visible tail is pinned
  const confirm = vi.spyOn(atomic, "syncPrivateFile").mockRejectedValueOnce(new Error("verification sync failed"));
  await expect(f.archive.confirm()).rejects.toThrow("verification sync failed");
  confirm.mockRejectedValueOnce(new Error("replay sync failed"));
  await expect(f.capture("second")).rejects.toThrow("replay sync failed"); confirm.mockRestore();
  await f.archive.confirm();
  await f.capture("second");
  expect(await new StrigoiSourceArchive(f.root, f.packets).list()).toHaveLength(2);
});

it("extends a pre-existing v1 snapshot without replacing originals", async () => {
  const f = await fixture(), refs = await f.packets.copy({ kind: "turn", id: "legacy", revision: "1" }, "Original legacy text", [identity.sessionId]);
  const body = JSON.stringify({ schemaVersion: 1, sources: refs, sha256: createHash("sha256").update(JSON.stringify(refs)).digest("hex") }) + "\n";
  await atomic.writeAtomicPrivateFile(f.archive.path, body); await atomic.writeAtomicPrivateFile(`${f.archive.path}.initialized`, "1\n");
  await f.capture("new");
  expect(await readFile(f.archive.path, "utf8")).toBe(body);
  expect(await f.archive.list()).toHaveLength(2); await f.packets.verify(await f.archive.list());
});


it.each([false, true])("rejects a prefix overwrite during append before publishing a new durable head (rehashed=%s)", async rehashed => {
  const f = await fixture(); await f.capture("first");
  const head = await readFile(`${f.journal}.head`, "utf8");
  const original = await readFile(f.journal, "utf8"), open = privateFiles.openPrivateAppendFile;
  let injected = false;
  vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementation(async path => {
    const file = await open(path);
    if (path === f.journal) {
      const write = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementation(async (...args) => {
        injected = true;
        let replacement = original.replace("first", "other");
        if (rehashed) {
          const entry = JSON.parse(replacement);
          entry.sha256 = createHash("sha256").update(JSON.stringify({ previous: entry.previous, sources: entry.sources })).digest("hex");
          replacement = JSON.stringify(entry) + "\n";
        }
        expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
        await writeFile(path, replacement);
        return write(...args);
      });
    }
    return file;
  });
  await expect(f.capture("second")).rejects.toThrow("STRIGOI_CORRUPT_PINS");
  expect(injected).toBe(true);
  expect(await readFile(`${f.journal}.head`, "utf8")).toBe(head);
  await expect(f.archive.list()).rejects.toThrow("STRIGOI_CORRUPT_PINS");
  await expect(new StrigoiSourceArchive(f.root, f.packets).list()).rejects.toThrow("STRIGOI_CORRUPT_PINS");
});

it("does not let a returned source list mutate retained archive projections", async () => {
  const f = await fixture(); await f.capture("first");
  const sources = await f.archive.list(); sources[0]!.id = "forged"; sources[0]!.sessionIds!.length = 0;
  expect(await f.archive.list()).toEqual(await new StrigoiSourceArchive(f.root, f.packets).list());
  expect((await f.archive.pins()).has(identity.sessionId)).toBe(true);
});
