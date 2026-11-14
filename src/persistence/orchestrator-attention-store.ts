import { bindingAuthorityHeld, withBindingAuthority } from "./binding-authority.js";
import type { EvidenceReferenceGuard } from "./strigoi-evidence-deletion.js";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AttentionError, OrchestratorAttentionSchema, type OrchestratorAttention } from "../domain/orchestrator-attention.js";
import type { AttentionStorePort } from "../orchestration/orchestrator-attention-ports.js";
import { writeAtomicPrivateFile } from "./atomic-private-file.js";

/** No cached authority: an ambiguous rename/sync is reread before the next mutation or retry. */
export class OrchestratorAttentionStore implements AttentionStorePort {
  readonly directory: string;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly stateDirectory: string, private readonly write = writeAtomicPrivateFile,
    private readonly capture?: (record: OrchestratorAttention) => Promise<void>, private readonly withReferences?: EvidenceReferenceGuard) {
    this.directory = join(stateDirectory, "orchestration", "attention-v1");
  }

  path(controllerId: string): string {
    return join(this.directory, `${createHash("sha256").update(controllerId).digest("hex")}.json`);
  }

  get(controllerId: string): Promise<OrchestratorAttention | undefined> {
    return this.ordered(controllerId, () => this.read(this.path(controllerId), controllerId));
  }

  async list(): Promise<OrchestratorAttention[]> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: OrchestratorAttention[] = [];
    // Interrupted atomic replacements are not committed records; leave them for the operator.
    for (const name of names.sort().filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = await this.read(join(this.directory, name));
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  async update(controllerId: string, change: (current: OrchestratorAttention | undefined) =>
    Promise<OrchestratorAttention | undefined>, admitCommit?: (commit: () => Promise<void>) => Promise<void>): Promise<OrchestratorAttention | undefined> {
    return this.ordered(controllerId, async () => {
      // Preparation can drain transcripts. An authority owner bypasses this ordering
      // tail; the disk CAS prevents its update being overwritten by stale preparation.
      for (;;) {
        const current = await this.read(this.path(controllerId), controllerId);
        const next = await change(structuredClone(current));
        const parsed = next === undefined ? current : OrchestratorAttentionSchema.parse(next);
        const result = await withBindingAuthority(this.stateDirectory, async () => {
          if (JSON.stringify(await this.read(this.path(controllerId), controllerId)) !== JSON.stringify(current)) return { retry: true } as const;
          if (parsed === undefined) { await admitCommit?.(async () => {}); return { record: current } as const; }
          if (parsed.controllerId !== controllerId) throw new AttentionError("ATTENTION_CORRUPT", "Controller identity mismatch");
          if (JSON.stringify(current) !== JSON.stringify(parsed)) {
            const commit = async () => {
              if (current) await this.capture?.(current);
              await this.write(this.path(controllerId), `${JSON.stringify(parsed)}\n`);
              await this.capture?.(parsed);
            };
            // Only a cancellation of the exact existing record is a release. A changed actor,
            // epoch, statement, authority, or coverage must still pass reference acquisition.
            const cancellation = current !== undefined && parsed.status === "cancelled"
              && JSON.stringify(OrchestratorAttentionSchema.parse({ ...parsed, status: current.status, updatedAt: current.updatedAt,
                cancelledAt: current.cancelledAt, cancelReason: current.cancelReason, pendingIntent: current.pendingIntent,
                lastWake: parsed.lastWake && current.lastWake && parsed.lastWake.holdReason === "attention-cancelled"
                  ? { ...parsed.lastWake, holdReason: current.lastWake.holdReason } : parsed.lastWake })) === JSON.stringify(current);
            const admitted = () => admitCommit ? admitCommit(commit) : commit();
            if (this.withReferences) await this.withReferences(cancellation ? [] : [parsed.actorSessionId, ...parsed.statement.targets.map((t) => t.sessionId)], admitted);
            else await admitted();
          } else await admitCommit?.(async () => {});
          return { record: parsed } as const;
        });
        if (!("retry" in result)) return result.record;
      }
    });
  }

  private async ordered<T>(controllerId: string, work: () => Promise<T>): Promise<T> {
    const owner = bindingAuthorityHeld(this.stateDirectory);
    const prior = this.tails.get(controllerId) ?? Promise.resolve();
    const operation = owner ? work() : prior.then(work);
    // Include bypassed activation callbacks in the tail seen by later ordinary
    // readers. The owner awaits only its own work, never a waiter for authority.
    const settled = Promise.allSettled([prior, operation]).then(() => {});
    this.tails.set(controllerId, settled);
    void settled.then(() => { if (this.tails.get(controllerId) === settled) this.tails.delete(controllerId); });
    return operation;
  }

  private async read(path: string, controllerId?: string): Promise<OrchestratorAttention | undefined> {
    let body: string;
    try { body = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const record = OrchestratorAttentionSchema.parse(JSON.parse(body));
      if (this.path(record.controllerId) !== path || (controllerId !== undefined && record.controllerId !== controllerId)) {
        throw new Error("identity mismatch");
      }
      return record;
    } catch {
      throw new AttentionError("ATTENTION_CORRUPT", `Invalid attention record at ${path}; recovery is held`);
    }
  }
}
