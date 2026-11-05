import { join } from "node:path";
import { InstructionRecordSchema, type InstructionRecord } from "../domain/instruction.js";
import { ValidatedJournal } from "./validated-journal.js";
import { replayInstructionsNative } from "./native-instruction-replay.js";

export interface InstructionStoreOptions {
  replay?: "typescript" | "rust";
  nativeBinary?: string;
}
/** Append-only instruction snapshots. Latest record per id is the current mailbox state. */
export class InstructionStore {
  readonly path: string;
  private readonly journal: ValidatedJournal<Map<string, InstructionRecord>>;

  constructor(stateDirectory: string, options: InstructionStoreOptions = {}) {
    this.path = join(stateDirectory, "orchestration", "instructions.jsonl");
    // Notification recovery reads this mailbox once per controller. Replaying the entire journal
    // for every read made broker startup exceed its readiness deadline on ordinary history.
    // The shared cache checks file identity on every read, including other writers and replacement.
    const replay = options.replay ?? process.env.CYBERDECK_INSTRUCTION_REPLAY ?? "typescript";
    if (replay !== "typescript" && replay !== "rust") throw new Error("CYBERDECK_INSTRUCTION_REPLAY must be typescript or rust");
    this.journal = new ValidatedJournal(this.path, projectInstructions,
      replay === "rust" ? (file) => replayInstructionsNative(file,
        options.nativeBinary === undefined ? {} : { binary: options.nativeBinary }) : undefined);
  }

  async put(record: InstructionRecord): Promise<void> {
    const parsed = InstructionRecordSchema.parse(record);
    await this.journal.append(parsed);
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
