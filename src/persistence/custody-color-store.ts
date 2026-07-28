import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CustodyColorTableSchema, type CustodyColorTable } from "../domain/custody-color.js";
import { openPrivateAppendFile } from "./private-files.js";

const CustodyColorRecordSchema = z.object({
  recordType: z.literal("custody.colors"),
  persistedAt: z.iso.datetime(),
  slots: CustodyColorTableSchema,
});

/**
 * Append-only, latest line wins. The whole six-slot table is one record because the
 * allocation rules are stated over the table as a whole: a partial ledger read after a
 * crash could hand two controllers the same hue, which is the one outcome that must not
 * happen. Six entries is small enough that snapshotting them costs nothing.
 */
export class CustodyColorStore {
  readonly path: string;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "orchestration", "custody-colors.jsonl");
  }

  async read(): Promise<CustodyColorTable> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    let latest: CustodyColorTable = [];
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue;
      try {
        latest = CustodyColorRecordSchema.parse(JSON.parse(line)).slots;
      } catch (error) {
        throw new Error(`Invalid custody color record at line ${index + 1}`, { cause: error });
      }
    }
    return latest;
  }

  async write(table: CustodyColorTable): Promise<CustodyColorTable> {
    const record = CustodyColorRecordSchema.parse({
      recordType: "custody.colors",
      persistedAt: new Date().toISOString(),
      slots: table,
    });
    const handle = await openPrivateAppendFile(this.path);
    try {
      await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return record.slots;
  }
}
