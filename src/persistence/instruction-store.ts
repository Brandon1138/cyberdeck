import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InstructionRecordSchema, type InstructionRecord } from "../domain/instruction.js";
import { openPrivateAppendFile } from "./private-files.js";

/** Append-only instruction snapshots. Latest record per id is the current mailbox state. */
export class InstructionStore {
  readonly path: string;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "orchestration", "instructions.jsonl");
  }

  async put(record: InstructionRecord): Promise<void> {
    const parsed = InstructionRecordSchema.parse(record);
    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(`${JSON.stringify(parsed)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async list(targetSessionId?: string): Promise<InstructionRecord[]> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const latest = new Map<string, InstructionRecord>();
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (line.trim() === "") continue;
      const record = InstructionRecordSchema.parse(JSON.parse(line));
      latest.set(record.id, record);
    }
    return [...latest.values()].filter((record) => targetSessionId === undefined || record.targetSessionId === targetSessionId);
  }
}
