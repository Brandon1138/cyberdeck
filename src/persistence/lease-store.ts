import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CONTROL_PLANE_SCHEMA_VERSION, schemaVersionField } from "../domain/control-plane.js";
import { WorktreeLeaseSchema } from "../domain/lease.js";

export const DurableLeaseRecordSchema = z.object({
  schemaVersion: schemaVersionField,
  lease: WorktreeLeaseSchema,
  access: z.enum(["read-only", "workspace-write"]),
  canonicalRepositoryPath: z.string().min(1),
  canonicalWorktreePath: z.string().min(1),
  canonicalKey: z.string().min(3),
  fencingToken: z.number().int().positive(),
  ownerKey: z.string().min(1),
  lastRenewedAt: z.iso.datetime(),
  orphanedAt: z.iso.datetime().optional(),
  orphanReason: z.string().min(1).optional(),
});
export type DurableLeaseRecord = z.infer<typeof DurableLeaseRecordSchema>;

const LeaseEnvelopeSchema = z.object({
  schemaVersion: schemaVersionField,
  recordType: z.literal("lease.snapshot"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  state: DurableLeaseRecordSchema,
});

export class LeaseStoreError extends Error {
  constructor(
    readonly code: "STORE_CORRUPT" | "SCHEMA_VERSION_UNSUPPORTED" | "DUPLICATE_EVENT_ID",
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "LeaseStoreError";
  }
}

export interface LeaseStoreOptions {
  now?: () => string;
  idFactory?: () => string;
}

/** Append-only, fsynced lease snapshots; replay retains the latest record for each lease id. */
export class LeaseStore {
  readonly path: string;

  constructor(
    stateDirectory: string,
    private readonly options: LeaseStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "control-plane", "leases.jsonl");
  }

  async append(state: DurableLeaseRecord): Promise<void> {
    const validated = DurableLeaseRecordSchema.parse(state);
    assertSupportedVersions(validated);
    const envelope = LeaseEnvelopeSchema.parse({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      recordType: "lease.snapshot",
      eventId: this.options.idFactory?.() ?? randomUUID(),
      persistedAt: this.options.now?.() ?? new Date().toISOString(),
      state: validated,
    });
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(envelope)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async load(): Promise<DurableLeaseRecord[]> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (content === undefined || content.length === 0) return [];
    const lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();
    else lines.pop();
    const eventIds = new Set<string>();
    const latest = new Map<string, DurableLeaseRecord>();
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") {
        throw new LeaseStoreError("STORE_CORRUPT", `Blank lease record at line ${index + 1}`, index + 1);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        throw new LeaseStoreError(
          "STORE_CORRUPT",
          `Invalid lease JSON at line ${index + 1}: ${error instanceof Error ? error.message : "parse failed"}`,
          index + 1,
        );
      }
      if (typeof raw === "object" && raw !== null && "schemaVersion" in raw) {
        const version = (raw as { schemaVersion?: unknown }).schemaVersion;
        if (typeof version === "number" && version !== CONTROL_PLANE_SCHEMA_VERSION) {
          throw new LeaseStoreError(
            "SCHEMA_VERSION_UNSUPPORTED",
            `Unsupported lease schema version ${version} at line ${index + 1}`,
            index + 1,
          );
        }
      }
      const parsed = LeaseEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        throw new LeaseStoreError(
          "STORE_CORRUPT",
          `Invalid lease record at line ${index + 1}: ${z.prettifyError(parsed.error)}`,
          index + 1,
        );
      }
      assertSupportedVersions(parsed.data, index + 1);
      if (eventIds.has(parsed.data.eventId)) {
        throw new LeaseStoreError(
          "DUPLICATE_EVENT_ID",
          `Duplicate lease event ${parsed.data.eventId} at line ${index + 1}`,
          index + 1,
        );
      }
      eventIds.add(parsed.data.eventId);
      latest.set(parsed.data.state.lease.leaseId, parsed.data.state);
    }
    return [...latest.values()];
  }
}

function assertSupportedVersions(value: unknown, line?: number): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSupportedVersions(item, line);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const object = value as Record<string, unknown>;
  if (
    typeof object.schemaVersion === "number" &&
    object.schemaVersion !== CONTROL_PLANE_SCHEMA_VERSION
  ) {
    throw new LeaseStoreError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported lease schema version ${object.schemaVersion}${line === undefined ? "" : ` at line ${line}`}`,
      line,
    );
  }
  for (const child of Object.values(object)) assertSupportedVersions(child, line);
}
