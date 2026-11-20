import type { EvidenceReferenceGuard } from "./strigoi-evidence-deletion.js";
import { join } from "node:path";
import { InstructionRecordSchema, effectiveInstruction, instructionSessionIds, type InstructionRecord } from "../domain/instruction.js";
import { NativeInstructionIndex, type InstructionQuery } from "./native-instruction-index.js";
import { ValidatedJournal } from "./validated-journal.js";
import { withBindingAuthority } from "./binding-authority.js";

interface Projection {
  unsettled: InstructionRecord[];
  latest: Map<string, InstructionRecord>;
  targets: Map<string, InstructionRecord[]>;
}

/** Append-only instruction snapshots. Latest record per id is the current mailbox state. */
export class InstructionStore {
  readonly path: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly journal: ValidatedJournal<Projection>;
  private fallback: ValidatedJournal<Projection> | undefined;
  private readonly native: NativeInstructionIndex | undefined;

  constructor(private readonly stateDirectory: string, private readonly capture?: (record: InstructionRecord) => Promise<void>, private readonly withReferences?: EvidenceReferenceGuard) {
    this.path = join(stateDirectory, "orchestration", "instructions.jsonl");
    if (process.env.CYBERDECK_INSTRUCTION_INDEX === "rust") this.native = new NativeInstructionIndex(this.path);
    // Notification recovery reads this mailbox once per controller. Replaying the entire journal
    // for every read made broker startup exceed its readiness deadline on ordinary history.
    // The shared cache checks file identity on every read, including other writers and replacement.
    this.journal = new ValidatedJournal(this.path, instructionProjector());
  }

  put(record: InstructionRecord): Promise<void> {
    const parsed = InstructionRecordSchema.parse(record);
    // Activation and resident delivery already own authority. Never reserve a writer
    // behind which that owner could wait while this writer waits for authority.
    return withBindingAuthority(this.stateDirectory, () => {
      const work = this.tail.catch(() => {}).then(async () => {
        const prior = await this.get(parsed.id);
        validateContinuation(prior, parsed);
        const commit = async () => { await this.journal.append(parsed); await this.capture?.(parsed); };
        if (this.withReferences) await this.withReferences(instructionSessionIds(parsed), commit);
        else await commit();
      });
      this.tail = work; return work;
    });
  }

  async list(targetSessionId?: string): Promise<InstructionRecord[]> {
    return this.query(targetSessionId === undefined ? "all" : { target: targetSessionId });
  }

  listUnsettled(): Promise<InstructionRecord[]> { return this.query("unsettled"); }

  async get(id: string): Promise<InstructionRecord | undefined> {
    return (await this.query({ id }))[0];
  }

  close(): void { this.native?.close(); }

  private async query(query: InstructionQuery): Promise<InstructionRecord[]> {
    const select = ({ latest, targets, unsettled }: Projection) => {
      if (query === "unsettled") return unsettled;
      if (query === "all") return [...latest.values()];
      if ("target" in query) return targets.get(query.target) ?? [];
      const row = latest.get(query.id);
      return row ? [row] : [];
    };
    const native = this.native;
    if (!native) return this.journal.readSelected(select);
    return this.journal.enqueue(async () => {
      const rows = await native.read(query);
      if (rows !== undefined) {
        this.fallback = undefined;
        return rows;
      }
      this.fallback ??= new ValidatedJournal(this.path, instructionProjector());
      return this.fallback.readSelected(select);
    });
  }
}

function instructionProjector(): (content: string) => Projection {
  let committed = "", validated = new Map<string, InstructionRecord>();
  return (content) => {
    // ValidatedJournal still reads the entire changed file and checks descriptor/path identity.
    // Reuse requires comparing EVERY committed character, not assuming an append preserved the
    // prefix. A rewrite/truncation restarts validation; a torn tail is never part of the cache.
    const unchangedPrefix = content.startsWith(committed);
    const latest = unchangedPrefix ? new Map(validated) : new Map<string, InstructionRecord>();
    const boundary = content.lastIndexOf("\n") + 1;
    for (const line of content.slice(unchangedPrefix ? committed.length : 0, boundary).split("\n")) {
      if (line.trim() === "") continue;
      const record = InstructionRecordSchema.parse(JSON.parse(line));
      validateContinuation(latest.get(record.id), record);
      latest.set(record.id, record);
    }
    // A rejected suffix must not publish partial records or poison the next validation.
    committed = content.slice(0, boundary);
    validated = latest;
    const unsettled: InstructionRecord[] = [];
    const targets = new Map<string, InstructionRecord[]>();
    for (const row of latest.values()) {
      if (!["completed", "cancelled", "undelivered"].includes(row.status)) unsettled.push(row);
      const effective = effectiveInstruction(row).targetSessionId;
      for (const target of effective === row.targetSessionId ? [effective] : [row.targetSessionId, effective]) {
        const records = targets.get(target);
        if (records) records.push(row);
        else targets.set(target, [row]);
      }
    }
    return { latest, targets, unsettled };
  };
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
