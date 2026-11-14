import type { EvidenceReferenceGuard } from "./strigoi-evidence-deletion.js";
import { join } from "node:path";
import { InstructionRecordSchema, effectiveInstruction, instructionSessionIds, type InstructionRecord } from "../domain/instruction.js";
import { ValidatedJournal } from "./validated-journal.js";
import { withBindingAuthority } from "./binding-authority.js";

/** Append-only instruction snapshots. Latest record per id is the current mailbox state. */
export class InstructionStore {
  readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly journal: ValidatedJournal<Map<string, InstructionRecord>>;

  constructor(private readonly stateDirectory: string, private readonly capture?: (record: InstructionRecord) => Promise<void>, private readonly withReferences?: EvidenceReferenceGuard) {
    this.path = join(stateDirectory, "orchestration", "instructions.jsonl");
    // Notification recovery reads this mailbox once per controller. Replaying the entire journal
    // for every read made broker startup exceed its readiness deadline on ordinary history.
    // The shared cache checks file identity on every read, including other writers and replacement.
    this.journal = new ValidatedJournal(this.path, projectInstructions);
  }

  put(record: InstructionRecord): Promise<void> {
    const parsed = InstructionRecordSchema.parse(record);
    // Activation and resident delivery already own authority. Never reserve a writer
    // behind which that owner could wait while this writer waits for authority.
    return withBindingAuthority(this.stateDirectory, () => {
      const work = this.tail.catch(() => {}).then(async () => {
        const prior = (await this.journal.read()).get(parsed.id);
        validateContinuation(prior, parsed);
        const commit = async () => { await this.journal.append(parsed); await this.capture?.(parsed); };
        if (this.withReferences) await this.withReferences(instructionSessionIds(parsed), commit);
        else await commit();
      });
      this.tail = work; return work;
    });
  }

  async list(targetSessionId?: string): Promise<InstructionRecord[]> {
    const latest = await this.journal.read();
    return structuredClone([...latest.values()].filter((record) => targetSessionId === undefined || (record.targetSessionId === targetSessionId || effectiveInstruction(record).targetSessionId === targetSessionId)));
  }
}

function projectInstructions(content: string): Map<string, InstructionRecord> {
  const latest = new Map<string, InstructionRecord>();
  const lines = content.split("\n");
  if (!content.endsWith("\n")) lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const record = InstructionRecordSchema.parse(JSON.parse(line));
    validateContinuation(latest.get(record.id), record);
    latest.set(record.id, record);
  }
  return latest;
}

function validateContinuation(prior: InstructionRecord | undefined, record: InstructionRecord): void {
  for (const receipt of record.continuations ?? []) {
    if (receipt.instructionId !== record.id || receipt.originalActorSessionId !== record.actorSessionId
      || receipt.originalTargetSessionId !== record.targetSessionId) throw new Error("INSTRUCTION_CONTINUATION_IDENTITY_MISMATCH");
    if (!record.logicalRecipient && receipt.effectiveTargetSessionId !== record.targetSessionId) throw new Error("INSTRUCTION_EXPLICIT_TARGET_IMMUTABLE");
  }
  if (!prior) return;
  for (const key of ["actorSessionId", "targetSessionId", "senderSessionId", "message", "messageId", "logicalRecipient", "workflowRunId", "createdAt"] as const) {
    if (JSON.stringify(prior[key]) !== JSON.stringify(record[key])) throw new Error("INSTRUCTION_ORIGINAL_IMMUTABLE");
  }
  const previous = prior.continuations ?? [], next = record.continuations ?? [];
  if (previous.some((receipt, i) => JSON.stringify(receipt) !== JSON.stringify(next[i]))) throw new Error("INSTRUCTION_CONTINUATION_APPEND_ONLY");
  if (next.length > previous.length && (prior.launch === true || !["accepted", "queued"].includes(prior.status))) throw new Error("INSTRUCTION_CONTINUATION_UNSAFE");
}
