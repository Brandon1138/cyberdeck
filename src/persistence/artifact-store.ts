import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { z } from "zod";
import {
  ArtifactIdSchema,
  CONTROL_PLANE_SCHEMA_VERSION,
  JobIdSchema,
  schemaVersionField,
} from "../domain/control-plane.js";
import { ArtifactDescriptorSchema, type ArtifactDescriptor } from "../domain/artifact.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

const ArtifactMetadataSchema = z.object({
  schemaVersion: schemaVersionField,
  logicalKind: z.string().min(1).optional(),
  descriptor: ArtifactDescriptorSchema,
});

export interface ArtifactWriteRequest {
  name: string;
  logicalKind?: string;
  mediaType: string;
  content: Buffer | string;
  producedByJobId?: string;
}

export interface StoredArtifact {
  descriptor: ArtifactDescriptor;
  logicalKind?: string;
}

export interface ResolvedArtifact extends StoredArtifact {
  content: Buffer;
}

export interface ArtifactStoreOptions {
  maxArtifactBytes?: number;
  maxReadBytes?: number;
  now?: () => string;
  idFactory?: () => string;
}

export type ArtifactStoreErrorCode =
  | "ARTIFACT_INVALID_ID"
  | "ARTIFACT_INVALID_NAME"
  | "ARTIFACT_INVALID_METADATA"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_CORRUPT"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_PATH_ESCAPE"
  | "ARTIFACT_EXTERNAL_UNRESOLVED"
  | "SCHEMA_VERSION_UNSUPPORTED";

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

/** Local, content-addressed artifact storage. Metadata is collision-safe by artifact UUID. */
export class ArtifactStore {
  readonly root: string;
  private readonly contentRoot: string;
  private readonly metadataRoot: string;
  private readonly maxArtifactBytes: number;
  private readonly maxReadBytes: number;

  constructor(
    stateDirectory: string,
    private readonly options: ArtifactStoreOptions = {},
  ) {
    this.root = join(stateDirectory, "artifacts");
    this.contentRoot = join(this.root, "sha256");
    this.metadataRoot = join(this.root, "metadata");
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxReadBytes = options.maxReadBytes ?? this.maxArtifactBytes;
  }

  async write(request: ArtifactWriteRequest): Promise<StoredArtifact> {
    validateLogicalName(request.name);
    if (request.mediaType.trim() === "") {
      throw new ArtifactStoreError("ARTIFACT_INVALID_METADATA", "mediaType must not be empty");
    }
    const content = Buffer.isBuffer(request.content)
      ? Buffer.from(request.content)
      : Buffer.from(request.content, "utf8");
    if (content.byteLength > this.maxArtifactBytes) {
      throw new ArtifactStoreError(
        "ARTIFACT_TOO_LARGE",
        `Artifact is ${content.byteLength} bytes; limit is ${this.maxArtifactBytes}`,
      );
    }

    const id = ArtifactIdSchema.parse(this.options.idFactory?.() ?? randomUUID());
    const producedByJobId =
      request.producedByJobId === undefined ? undefined : JobIdSchema.parse(request.producedByJobId);
    const digestHex = createHash("sha256").update(content).digest("hex");
    const digest = `sha256:${digestHex}`;
    const contentPath = join(this.contentRoot, digestHex);
    this.assertInsideRoot(contentPath);

    await mkdir(this.contentRoot, { recursive: true });
    await mkdir(this.metadataRoot, { recursive: true });
    const existing = await readFile(contentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined) {
      await atomicWrite(contentPath, content);
    } else if (!existing.equals(content)) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPT", `Digest collision at ${contentPath}`);
    }

    const descriptor = ArtifactDescriptorSchema.parse({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      id,
      name: request.name,
      mediaType: request.mediaType,
      byteLength: content.byteLength,
      digest,
      content: { kind: "file", path: contentPath, mediaType: request.mediaType },
      ...(producedByJobId !== undefined ? { producedByJobId } : {}),
      createdAt: this.options.now?.() ?? new Date().toISOString(),
    });
    const metadata = ArtifactMetadataSchema.parse({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      descriptor,
      ...(request.logicalKind !== undefined ? { logicalKind: request.logicalKind } : {}),
    });
    await atomicWrite(this.metadataPath(id), Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"));
    return {
      descriptor,
      ...(metadata.logicalKind !== undefined ? { logicalKind: metadata.logicalKind } : {}),
    };
  }

  async read(id: string): Promise<ResolvedArtifact> {
    const parsedId = ArtifactIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw new ArtifactStoreError("ARTIFACT_INVALID_ID", `Invalid artifact id ${id}`);
    }
    const metadataPath = this.metadataPath(parsedId.data);
    const raw = await readFile(metadataPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new ArtifactStoreError("ARTIFACT_MISSING", `Artifact ${id} does not exist`);
      }
      throw error;
    });
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new ArtifactStoreError(
        "ARTIFACT_CORRUPT",
        `Artifact ${id} metadata is invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
      );
    }
    if (
      typeof parsedJson === "object" &&
      parsedJson !== null &&
      "schemaVersion" in parsedJson &&
      (parsedJson as { schemaVersion?: unknown }).schemaVersion !== CONTROL_PLANE_SCHEMA_VERSION
    ) {
      throw new ArtifactStoreError(
        "SCHEMA_VERSION_UNSUPPORTED",
        `Unsupported artifact schema version ${String((parsedJson as { schemaVersion?: unknown }).schemaVersion)}`,
      );
    }
    const metadata = ArtifactMetadataSchema.safeParse(parsedJson);
    if (!metadata.success || metadata.data.descriptor.id !== parsedId.data) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPT", `Artifact ${id} metadata failed validation`);
    }
    const descriptor = metadata.data.descriptor;
    if (descriptor.content.kind !== "file") {
      throw new ArtifactStoreError("ARTIFACT_CORRUPT", `Stored artifact ${id} is not a file reference`);
    }
    this.assertInsideRoot(descriptor.content.path);
    const digestHex = digestHexFromDescriptor(descriptor);
    const expectedPath = join(this.contentRoot, digestHex);
    if (resolvePath(descriptor.content.path) !== resolvePath(expectedPath)) {
      throw new ArtifactStoreError("ARTIFACT_PATH_ESCAPE", `Artifact ${id} references an unexpected path`);
    }
    const info = await stat(expectedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new ArtifactStoreError("ARTIFACT_MISSING", `Artifact content ${id} does not exist`);
      }
      throw error;
    });
    if (!info.isFile()) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPT", `Artifact content ${id} is not a file`);
    }
    if (info.size > this.maxReadBytes) {
      throw new ArtifactStoreError(
        "ARTIFACT_TOO_LARGE",
        `Artifact is ${info.size} bytes; read limit is ${this.maxReadBytes}`,
      );
    }
    if (descriptor.byteLength !== info.size) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPT", `Artifact ${id} byte length does not match`);
    }
    const content = await readFile(expectedPath);
    verifyContent(descriptor, content);
    return {
      descriptor,
      content,
      ...(metadata.data.logicalKind !== undefined
        ? { logicalKind: metadata.data.logicalKind }
        : {}),
    };
  }

  async resolve(input: unknown): Promise<Buffer> {
    const descriptor = ArtifactDescriptorSchema.parse(input);
    if (descriptor.content.kind === "external") {
      throw new ArtifactStoreError(
        "ARTIFACT_EXTERNAL_UNRESOLVED",
        "External artifact references are never fetched by the local store",
      );
    }
    if (descriptor.content.kind === "inline") {
      const content = Buffer.from(descriptor.content.text, "utf8");
      if (content.byteLength > this.maxReadBytes) {
        throw new ArtifactStoreError("ARTIFACT_TOO_LARGE", "Inline artifact exceeds read limit");
      }
      if (descriptor.content.mediaType !== descriptor.mediaType) {
        throw new ArtifactStoreError("ARTIFACT_CORRUPT", "Inline artifact media type mismatch");
      }
      verifyContent(descriptor, content);
      return content;
    }
    this.assertInsideRoot(descriptor.content.path);
    const stored = await this.read(descriptor.id);
    if (JSON.stringify(stored.descriptor) !== JSON.stringify(descriptor)) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPT", "Artifact descriptor does not match metadata");
    }
    return stored.content;
  }

  /**
   * Every stored artifact id, for read-only reconciliation. A missing store is an empty inventory,
   * and anything that is not a valid artifact metadata file is ignored rather than guessed at.
   */
  async listIds(): Promise<string[]> {
    const entries = await readdir(this.metadataRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter((id) => ArtifactIdSchema.safeParse(id).success);
  }

  metadataPath(id: string): string {
    const path = join(this.metadataRoot, `${id}.json`);
    this.assertInsideRoot(path);
    return path;
  }

  private assertInsideRoot(path: string): void {
    const relation = relative(resolvePath(this.root), resolvePath(path));
    if (relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) {
      return;
    }
    throw new ArtifactStoreError("ARTIFACT_PATH_ESCAPE", `Artifact path escapes store root: ${path}`);
  }
}

function validateLogicalName(name: string): void {
  if (
    name.trim() === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new ArtifactStoreError("ARTIFACT_INVALID_NAME", `Unsafe artifact name ${name}`);
  }
}

function digestHexFromDescriptor(descriptor: ArtifactDescriptor): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(descriptor.digest ?? "");
  if (match?.[1] === undefined) {
    throw new ArtifactStoreError("ARTIFACT_CORRUPT", "Artifact digest is missing or invalid");
  }
  return match[1];
}

function verifyContent(descriptor: ArtifactDescriptor, content: Buffer): void {
  if (descriptor.byteLength !== undefined && descriptor.byteLength !== content.byteLength) {
    throw new ArtifactStoreError("ARTIFACT_CORRUPT", "Artifact byte length does not match");
  }
  if (descriptor.digest !== undefined) {
    const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actual !== descriptor.digest) {
      throw new ArtifactStoreError("ARTIFACT_CORRUPT", "Artifact digest does not match");
    }
  }
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.write(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
