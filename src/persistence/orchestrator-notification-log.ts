import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  NotificationDeliveryChannelSchema, NotificationPolicySchema, OrchestratorNotificationSchema,
} from "../domain/orchestrator-notification.js";

const envelope = {
  schemaVersion: z.literal(1), recordId: z.uuid(), persistedAt: z.iso.datetime(),
};
const controllerId = z.string().min(1);
const ids = z.array(z.uuid());
const at = z.iso.datetime();
export const NotificationLogRecordSchema = z.discriminatedUnion("recordType", [
  z.object({ ...envelope, recordType: z.literal("orchestrator-notification.append"),
    notification: OrchestratorNotificationSchema }),
  z.object({ ...envelope, recordType: z.literal("orchestrator-notification.replace"),
    notification: OrchestratorNotificationSchema, replacesId: z.uuid() }),
  z.object({ ...envelope, recordType: z.literal("orchestrator-notification.acknowledge"),
    controllerId, throughCursor: z.number().int().nonnegative(), at,
    /** Optional selective acknowledgement; absence retains cursor-prefix semantics. */
    ids: ids.min(1).optional() }),
  z.object({ ...envelope, recordType: z.literal("orchestrator-notification.deliver"),
    controllerId, ids, via: NotificationDeliveryChannelSchema, at }),
  z.object({ ...envelope, recordType: z.literal("orchestrator-notification.drop"),
    controllerId, ids: ids.min(1), reason: z.literal("capacity"), at }),
  z.object({ ...envelope, recordType: z.literal("orchestrator-notification.notice"),
    controllerId, cursor: z.number().int().nonnegative(), at }),
  z.object({ ...envelope, recordType: z.literal("orchestrator-notification.policy"),
    controllerId, policy: NotificationPolicySchema }),
]);
export type NotificationLogRecord = z.infer<typeof NotificationLogRecordSchema>;
export type NotificationLogPayload = NotificationLogRecord extends infer R
  ? R extends NotificationLogRecord ? Omit<R, "schemaVersion" | "recordId" | "persistedAt"> : never
  : never;

export class OrchestratorNotificationStoreError extends Error {
  constructor(
    readonly code: "STORE_CORRUPT" | "SCHEMA_VERSION_UNSUPPORTED" | "DUPLICATE_RECORD_ID",
    message: string,
    readonly line?: number,
  ) {
    super(message);
    this.name = "OrchestratorNotificationStoreError";
  }
}

export function corrupt(message: string, line?: number): never {
  throw new OrchestratorNotificationStoreError("STORE_CORRUPT", message, line);
}

function assertVersions(raw: unknown, line: number): void {
  if (typeof raw !== "object" || raw === null) return;
  if ("schemaVersion" in raw && typeof raw.schemaVersion === "number" && raw.schemaVersion !== 1) {
    throw new OrchestratorNotificationStoreError("SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported notification schema version ${raw.schemaVersion} at line ${line}`, line);
  }
  for (const child of Object.values(raw)) assertVersions(child, line);
}

/** Like the coordination log, ignore only the final fragment lacking a newline. */
export async function readNotificationLog(path: string): Promise<{
  records: NotificationLogRecord[]; completeBytes: number; hasCrashTail: boolean;
}> {
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const complete = content.slice(0, content.lastIndexOf("\n") + 1);
  const lines = complete.length === 0 ? [] : complete.slice(0, -1).split("\n");
  const records: NotificationLogRecord[] = [];
  const recordIds = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!;
    if (line.trim() === "") corrupt(`Blank notification record at line ${lineNumber}`, lineNumber);
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { corrupt(`Invalid notification JSON at line ${lineNumber}`, lineNumber); }
    assertVersions(raw, lineNumber);
    const parsed = NotificationLogRecordSchema.safeParse(raw);
    if (!parsed.success) corrupt(`Invalid notification record at line ${lineNumber}`, lineNumber);
    const record = parsed.data;
    if (recordIds.has(record.recordId)) {
      throw new OrchestratorNotificationStoreError("DUPLICATE_RECORD_ID",
        `Duplicate notification record ID at line ${lineNumber}`, lineNumber);
    }
    recordIds.add(record.recordId);
    records.push(record);
  }
  return { records, completeBytes: Buffer.byteLength(complete), hasCrashTail: complete !== content };
}
