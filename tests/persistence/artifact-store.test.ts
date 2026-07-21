import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../../src/persistence/artifact-store.js";

const directories: string[] = [];
const NOW = "2026-07-21T10:00:00.000Z";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function newStore(options: { maxArtifactBytes?: number; maxReadBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-artifacts-"));
  directories.push(directory);
  return new ArtifactStore(directory, { ...options, now: () => NOW });
}

describe("ArtifactStore", () => {
  it("atomically stores and resolves content with digest, length, media type, and provenance", async () => {
    const store = await newStore();
    const jobId = randomUUID();
    const saved = await store.write({
      name: "result.json",
      logicalKind: "structured-result",
      mediaType: "application/json",
      content: Buffer.from('{"ok":true}'),
      producedByJobId: jobId,
    });

    expect(saved.descriptor.byteLength).toBe(11);
    expect(saved.descriptor.digest).toBe(
      `sha256:${createHash("sha256").update('{"ok":true}').digest("hex")}`,
    );
    expect(saved.descriptor.producedByJobId).toBe(jobId);
    expect(saved.descriptor.content.kind).toBe("file");
    if (saved.descriptor.content.kind === "file") {
      expect(isAbsolute(saved.descriptor.content.path)).toBe(true);
      expect(relative(store.root, saved.descriptor.content.path)).not.toMatch(/^\.\./);
    }

    const resolved = await store.read(saved.descriptor.id);
    expect(resolved.content.toString("utf8")).toBe('{"ok":true}');
    expect(resolved.logicalKind).toBe("structured-result");
    expect(resolved.descriptor).toEqual(saved.descriptor);
  });

  it("deduplicates identical content while keeping collision-safe artifact ids", async () => {
    const store = await newStore();
    const first = await store.write({ name: "one.txt", mediaType: "text/plain", content: "same" });
    const second = await store.write({ name: "two.txt", mediaType: "text/plain", content: "same" });

    expect(first.descriptor.id).not.toBe(second.descriptor.id);
    if (first.descriptor.content.kind === "file" && second.descriptor.content.kind === "file") {
      expect(first.descriptor.content.path).toBe(second.descriptor.content.path);
    }
  });

  it("rejects traversal-shaped logical names and invalid ids", async () => {
    const store = await newStore();
    await expect(
      store.write({ name: "../../secret", mediaType: "text/plain", content: "no" }),
    ).rejects.toMatchObject({ code: "ARTIFACT_INVALID_NAME" });
    await expect(store.read("../../secret")).rejects.toMatchObject({ code: "ARTIFACT_INVALID_ID" });
  });

  it("returns an explicit missing error", async () => {
    const store = await newStore();
    await expect(store.read(randomUUID())).rejects.toMatchObject({ code: "ARTIFACT_MISSING" });
  });

  it("detects digest or byte-length corruption", async () => {
    const store = await newStore();
    const saved = await store.write({ name: "proof.txt", mediaType: "text/plain", content: "proof" });
    if (saved.descriptor.content.kind !== "file") throw new Error("expected file artifact");
    await writeFile(saved.descriptor.content.path, "tampered", "utf8");

    await expect(store.read(saved.descriptor.id)).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
  });

  it("enforces bounded writes and bounded reads", async () => {
    const store = await newStore({ maxArtifactBytes: 4, maxReadBytes: 3 });
    await expect(
      store.write({ name: "large.txt", mediaType: "text/plain", content: "12345" }),
    ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });

    const saved = await store.write({ name: "small.txt", mediaType: "text/plain", content: "1234" });
    await expect(store.read(saved.descriptor.id)).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
  });

  it("resolves bounded inline references and refuses external fetches", async () => {
    const store = await newStore();
    const inline = {
      schemaVersion: 1,
      id: randomUUID(),
      name: "inline.txt",
      mediaType: "text/plain",
      byteLength: 2,
      digest: `sha256:${createHash("sha256").update("ok").digest("hex")}`,
      content: { kind: "inline" as const, mediaType: "text/plain", text: "ok" },
      createdAt: NOW,
    };
    await expect(store.resolve(inline)).resolves.toEqual(Buffer.from("ok"));

    await expect(
      store.resolve({
        ...inline,
        content: { kind: "external", uri: "https://example.invalid/result", mediaType: "text/plain" },
      }),
    ).rejects.toMatchObject({ code: "ARTIFACT_EXTERNAL_UNRESOLVED" });
  });

  it("fails closed when metadata is malformed", async () => {
    const store = await newStore();
    const saved = await store.write({ name: "proof.txt", mediaType: "text/plain", content: "proof" });
    await writeFile(store.metadataPath(saved.descriptor.id), "not-json", "utf8");
    await expect(store.read(saved.descriptor.id)).rejects.toMatchObject({ code: "ARTIFACT_CORRUPT" });
    await expect(readFile(store.metadataPath(saved.descriptor.id), "utf8")).resolves.toBe("not-json");
  });
});
