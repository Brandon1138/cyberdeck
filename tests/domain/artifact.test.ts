import { describe, expect, it } from "vitest";
import { ArtifactDescriptorSchema, ContentReferenceSchema } from "../../src/domain/artifact.js";

describe("ContentReferenceSchema", () => {
  it("discriminates inline, file, and external content", () => {
    expect(ContentReferenceSchema.parse({ kind: "inline", mediaType: "text/plain", text: "hi" }).kind).toBe("inline");
    expect(ContentReferenceSchema.parse({ kind: "file", path: "/tmp/out.txt" }).kind).toBe("file");
    expect(ContentReferenceSchema.parse({ kind: "external", uri: "https://example/x" }).kind).toBe("external");
  });

  it("requires an absolute path for file references and rejects unknown kinds", () => {
    expect(() => ContentReferenceSchema.parse({ kind: "file", path: "relative.txt" })).toThrow();
    expect(() => ContentReferenceSchema.parse({ kind: "socket", fd: 3 })).toThrow();
  });
});

describe("ArtifactDescriptorSchema", () => {
  it("describes an artifact by reference without embedding storage", () => {
    const descriptor = ArtifactDescriptorSchema.parse({
      id: crypto.randomUUID(),
      name: "summary.md",
      mediaType: "text/markdown",
      content: { kind: "file", path: "/tmp/summary.md" },
      createdAt: "2026-07-21T00:00:00.000Z",
    });
    expect(descriptor.content.kind).toBe("file");
    expect(descriptor.byteLength).toBeUndefined();
    expect(descriptor.schemaVersion).toBe(1);
  });
});
