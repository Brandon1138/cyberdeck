import { join } from "node:path";
import { InstructionRecordSchema, type InstructionRecord } from "../domain/instruction.js";
import { ValidatedJournal } from "./validated-journal.js";

/** Append-only instruction snapshots. Latest record per id is the current mailbox state. */
export class InstructionStore {
  readonly path: string;
  private readonly journal: ValidatedJournal<Map<string, InstructionRecord>>;

  constructor(stateDirectory: string, private readonly capture?: (record: InstructionRecord) => Promise<void>) {
    this.path = join(stateDirectory, "orchestration", "instructions.jsonl");
    // Notification recovery reads this mailbox once per controller. Replaying the entire journal
    // for every read made broker startup exceed its readiness deadline on ordinary history.
    // The shared cache checks file identity on every read, including other writers and replacement.
    this.journal = new ValidatedJournal(this.path, projectInstructions);
  }

  async put(record: InstructionRecord): Promise<void> {
    const parsed = InstructionRecordSchema.parse(record);
    await this.journal.append(parsed);
    await this.capture?.(parsed);
  }

  async list(targetSessionId?: string): Promise<InstructionRecord[]> {
    const latest = await this.journal.read();
    return structuredClone([...latest.values()].filter((record) => targetSessionId === undefined || record.targetSessionId === targetSessionId));
  }
}

function projectInstructions(content: string): Map<string, InstructionRecord> {
  const latest = new Map<string, InstructionRecord>();
  const lines = content.split("\n");
  if (!content.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const record = InstructionRecordSchema.parse(JSON.parse(line));
    latest.set(record.id, record);
  }
  return latest;
}
