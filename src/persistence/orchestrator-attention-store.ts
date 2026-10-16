import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AttentionError, OrchestratorAttentionSchema, type OrchestratorAttention } from "../domain/orchestrator-attention.js";
import type { AttentionStorePort } from "../orchestration/orchestrator-attention-ports.js";
import { writeAtomicPrivateFile } from "./atomic-private-file.js";

/** No cached authority: an ambiguous rename/sync is reread before the next mutation or retry. */
export class OrchestratorAttentionStore implements AttentionStorePort {
  readonly directory: string;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(stateDirectory: string, private readonly write = writeAtomicPrivateFile) {
    this.directory = join(stateDirectory, "orchestration", "attention-v1");
  }

  path(controllerId: string): string {
    return join(this.directory, `${createHash("sha256").update(controllerId).digest("hex")}.json`);
  }

  get(controllerId: string): Promise<OrchestratorAttention | undefined> {
    return this.exclusive(controllerId, () => this.read(this.path(controllerId), controllerId));
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

  update(controllerId: string, change: (current: OrchestratorAttention | undefined) =>
    Promise<OrchestratorAttention | undefined>): Promise<OrchestratorAttention | undefined> {
    return this.exclusive(controllerId, async () => {
      const current = await this.read(this.path(controllerId), controllerId);
      const next = await change(current);
      if (next === undefined) return current;
      const parsed = OrchestratorAttentionSchema.parse(next);
      if (parsed.controllerId !== controllerId) throw new AttentionError("ATTENTION_CORRUPT", "Controller identity mismatch");
      if (JSON.stringify(current) !== JSON.stringify(parsed)) {
        await this.write(this.path(controllerId), `${JSON.stringify(parsed)}\n`);
      }
      return parsed;
    });
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

  private exclusive<T>(controllerId: string, operation: () => Promise<T>): Promise<T> {
    const pending = this.tails.get(controllerId) ?? Promise.resolve();
    const result = pending.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.tails.set(controllerId, settled);
    void settled.then(() => { if (this.tails.get(controllerId) === settled) this.tails.delete(controllerId); });
    return result;
  }
}
