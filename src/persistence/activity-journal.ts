import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentActivitySchema, type AgentActivity } from "../domain/agent-activity.js";
import type { ActivityLocation } from "./activity-disk-index.js";
import { openPrivateAppendFile } from "./private-files.js";

const FRAME_LIMIT = 256 * 1024;
export async function recoverActivityJournal(directory: string, visit: (event: AgentActivity, offset: number, bytes: number) => void): Promise<{ bytes: number; torn: boolean }> {
  const path = join(directory, "activity.jsonl");
  const created = await openPrivateAppendFile(path); await created.close();
  const file = await open(path, "r+");
  try {
    const size = (await file.stat()).size, buffer = Buffer.alloc(64 * 1024);
    let position = 0, offset = 0, partial = Buffer.alloc(0);
    while (position < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error("ACTIVITY_JOURNAL_TRUNCATED");
      position += bytesRead; partial = Buffer.concat([partial, buffer.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = partial.indexOf(10)) >= 0) {
        if (newline > FRAME_LIMIT) throw new Error("ACTIVITY_FRAME_LIMIT");
        const line = partial.subarray(0, newline).toString("utf8");
        if (line) visit(AgentActivitySchema.parse(JSON.parse(line)), offset, newline + 1);
        offset += newline + 1; partial = partial.subarray(newline + 1);
      }
      if (partial.length > FRAME_LIMIT) throw new Error("ACTIVITY_FRAME_LIMIT");
    }
    if (partial.length) {
      const evidence = join(directory, `activity-torn-tail-${randomUUID()}.bin`);
      await writeFile(evidence, partial, { flag: "wx", mode: 0o600 });
      const saved = await open(evidence, "r"); try { await saved.sync(); } finally { await saved.close(); }
      await file.truncate(offset); await file.sync();
    }
    return { bytes: offset, torn: partial.length > 0 };
  } finally { await file.close(); }
}
export async function readActivityLocation(path: string, location: ActivityLocation): Promise<AgentActivity> {
  if (location.bytes > FRAME_LIMIT) throw new Error("ACTIVITY_FRAME_LIMIT");
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(location.bytes);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, location.offset);
    if (bytesRead !== buffer.length) throw new Error("ACTIVITY_JOURNAL_TRUNCATED");
    const event = AgentActivitySchema.parse(JSON.parse(buffer.toString("utf8")));
    if (event.sequence !== location.sequence) throw new Error("ACTIVITY_INDEX_CONFLICT");
    return event;
  } finally { await file.close(); }
}
export async function copyActivitySuffix(path: string, temporary: string, start: number): Promise<void> {
  const source = await open(path, "r"), target = await open(temporary, "wx", 0o600);
  try {
    const size = (await source.stat()).size, buffer = Buffer.alloc(64 * 1024);
    let position = start;
    while (position < size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error("ACTIVITY_JOURNAL_TRUNCATED");
      await target.writeFile(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    await target.sync();
  } finally { await source.close(); await target.close(); }
}
