import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ReportBackRecordSchema,
  type JobStateRepository,
  type PersistedJobState,
} from "../control-plane/job-control-plane.js";
import { CONTROL_PLANE_SCHEMA_VERSION, schemaVersionField } from "../domain/control-plane.js";
import { JobRecordSchema } from "../domain/job.js";
import { UsageReportSchema } from "../domain/usage.js";
import { openPrivateAppendFile } from "./private-files.js";

const PersistedJobStateSchema = z.object({
  record: JobRecordSchema,
  idempotencyKey: z.string().min(1),
  parentSessionId: z.uuid().optional(),
  usage: UsageReportSchema.optional(),
  reportBack: ReportBackRecordSchema.optional(),
});

const JobStoreEnvelopeSchema = z.object({
  schemaVersion: schemaVersionField,
  recordType: z.literal("job.snapshot"),
  eventId: z.uuid(),
  persistedAt: z.iso.datetime(),
  state: PersistedJobStateSchema,
});

export type JobStoreErrorCode =
  | "STORE_CORRUPT"
  | "SCHEMA_VERSION_UNSUPPORTED"
  | "DUPLICATE_EVENT_ID";

export class JobStoreError extends Error {
  constructor(
    readonly code: JobStoreErrorCode,
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "JobStoreError";
  }
}

export interface JobStoreOptions {
  now?: () => string;
  idFactory?: () => string;
}

/**
 * Append-only, fsynced job-state snapshots. Every line is independently validated and provenance
 * tagged. Replay keeps the latest snapshot per job while preserving first-seen job order.
 */
export class JobStore implements JobStateRepository {
  readonly path: string;

  constructor(
    stateDirectory: string,
    private readonly options: JobStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "control-plane", "jobs.jsonl");
  }

  async append(state: PersistedJobState): Promise<void> {
    const validated = PersistedJobStateSchema.parse(state);
    assertSupportedVersions(validated);
    const envelope = JobStoreEnvelopeSchema.parse({
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      recordType: "job.snapshot",
      eventId: this.options.idFactory?.() ?? randomUUID(),
      persistedAt: this.options.now?.() ?? new Date().toISOString(),
      state: validated,
    });

    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(`${JSON.stringify(envelope)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async load(): Promise<PersistedJobState[]> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (content === undefined || content.length === 0) return [];

    const terminated = content.endsWith("\n");
    const lines = content.split("\n");
    if (terminated) lines.pop();
    else lines.pop(); // Crash-shaped unterminated tail: never replay a possibly partial record.

    const eventIds = new Set<string>();
    const latest = new Map<string, PersistedJobState>();
    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      if (rawLine === undefined || rawLine.trim() === "") {
        throw new JobStoreError("STORE_CORRUPT", `Blank record at line ${index + 1}`, index + 1);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(rawLine);
      } catch (error) {
        throw new JobStoreError(
          "STORE_CORRUPT",
          `Invalid JSON at line ${index + 1}: ${error instanceof Error ? error.message : "parse failed"}`,
          index + 1,
        );
      }
      assertEnvelopeVersion(raw, index + 1);
      const parsed = JobStoreEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        throw new JobStoreError(
          "STORE_CORRUPT",
          `Invalid job record at line ${index + 1}: ${z.prettifyError(parsed.error)}`,
          index + 1,
        );
      }
      assertSupportedVersions(parsed.data, index + 1);
      if (eventIds.has(parsed.data.eventId)) {
        throw new JobStoreError(
          "DUPLICATE_EVENT_ID",
          `Duplicate persistence event ${parsed.data.eventId} at line ${index + 1}`,
          index + 1,
        );
      }
      eventIds.add(parsed.data.eventId);
      const state: PersistedJobState = {
        record: parsed.data.state.record,
        idempotencyKey: parsed.data.state.idempotencyKey,
        ...(parsed.data.state.parentSessionId !== undefined
          ? { parentSessionId: parsed.data.state.parentSessionId }
          : {}),
        ...(parsed.data.state.usage !== undefined ? { usage: parsed.data.state.usage } : {}),
        ...(parsed.data.state.reportBack !== undefined
          ? { reportBack: parsed.data.state.reportBack }
          : {}),
      };
      latest.set(state.record.id, state);
    }
    return [...latest.values()];
  }
}

function assertEnvelopeVersion(raw: unknown, line: number): void {
  if (typeof raw !== "object" || raw === null || !("schemaVersion" in raw)) return;
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && version !== CONTROL_PLANE_SCHEMA_VERSION) {
    throw new JobStoreError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported schema version ${version} at line ${line}`,
      line,
    );
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
    throw new JobStoreError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported schema version ${object.schemaVersion}${line === undefined ? "" : ` at line ${line}`}`,
      line,
    );
  }
  for (const child of Object.values(object)) assertSupportedVersions(child, line);
}
