import { withBindingAuthority } from "./binding-authority.js";
import { StrigoiArchiveError } from "./strigoi-archive-error.js";
import { assertEvidenceRetainable, evidenceSafety } from "./strigoi-evidence-deletion.js";
import { createHash } from "node:crypto";
import { ValidatedJournal } from "./validated-journal.js";
import { StrigoiSourceJournal, optionalSourceFile, sourceRevisionKey, validateArchivedSources } from "./strigoi-source-journal.js";
import { join } from "node:path";
import { z } from "zod";
import { StrigoiSourceRefSchema, type StrigoiSourceRef } from "../domain/strigoi.js";
import type { StrigoiPacketPort } from "../orchestration/strigoi-ports.js";
import { syncPrivateFile, writeAtomicPrivateFile } from "./atomic-private-file.js";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const IndexSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(StrigoiSourceRefSchema), sha256: z.string() }).strict();
/** Evidence index only: it confers no delivery, consumption, lease or controller authority. */
export class StrigoiSourceArchive {
  readonly path: string;
  private readonly baseline: ValidatedJournal<{ sources: StrigoiSourceRef[]; keys: Set<string> } | undefined>;
  private readonly incremental: StrigoiSourceJournal;
  constructor(private readonly directory: string, private readonly packets: StrigoiPacketPort) {
    this.path = join(directory, "orchestration", "strigoi", "sources.json");
    this.incremental = new StrigoiSourceJournal(this.path);
    this.baseline = new ValidatedJournal(this.path, (body) => {
      if (body === "") return undefined;
      try {
        const index = IndexSchema.parse(JSON.parse(body)); validateArchivedSources(index.sources);
        if (index.sha256 !== digest(JSON.stringify(index.sources))) throw new Error("Checksum mismatch");
        return { sources: index.sources, keys: new Set(index.sources.map(sourceRevisionKey)) };
      } catch { throw new StrigoiArchiveError("STRIGOI_CORRUPT_PINS"); }
    });
  }
  async list(): Promise<StrigoiSourceRef[]> {
    return withBindingAuthority(this.directory, async () => {
      const { base, incremental } = await this.load();
      return structuredClone([...base?.sources ?? [], ...incremental.sources]);
    });
  }
  async pins(): Promise<ReadonlySet<string>> { return new Set([...(await evidenceSafety(this.directory)).retainedSessionIds, ...(await this.list()).flatMap((s) => s.sessionIds ?? [])]); }
  /** Explicit reverification must confirm visible-but-ambiguous index publication too. */
  confirm(): Promise<void> {
    return withBindingAuthority(this.directory, async () => {
      const { base, incremental } = await this.load();
      if (!base) return;
      await syncPrivateFile(this.path); await syncPrivateFile(`${this.path}.initialized`);
      if (await optionalSourceFile(`${this.incremental.path}.head`) !== undefined) await this.incremental.confirm(incremental);
    });
  }
  async capture(kind: StrigoiSourceRef["kind"], id: string, value: unknown, sessionIds: string[]): Promise<void> {
    const text = typeof value === "string" ? value : JSON.stringify(value), revision = digest(text);
    const key = sourceRevisionKey({ kind, id, revision });
    const exists = await withBindingAuthority(this.directory, async () => {
      await assertEvidenceRetainable(this.directory, sessionIds);
      const { base, incremental } = await this.load();
      if (base?.keys.has(key) || incremental.keys.has(key)) {
        if (base?.keys.has(key)) { await syncPrivateFile(this.path); await syncPrivateFile(`${this.path}.initialized`); }
        if (await optionalSourceFile(`${this.incremental.path}.head`) !== undefined) await this.incremental.confirm(incremental);
        return true;
      }
      return false;
    });
    if (exists) return;
    // Immutable copies precede publication, outside our own authority transaction.
    const copies = await this.packets.copy({ kind, id, revision }, text, sessionIds);
    await withBindingAuthority(this.directory, async () => {
      await assertEvidenceRetainable(this.directory, sessionIds);
      const { base, incremental } = await this.load();
      if (!base) {
        await writeAtomicPrivateFile(this.path, JSON.stringify({ schemaVersion: 1, sources: [], sha256: digest("[]") }) + "\n");
        await writeAtomicPrivateFile(`${this.path}.initialized`, "1\n");
      }
      await this.incremental.initialize();
      if (base?.keys.has(key) || incremental.keys.has(key)) { await this.incremental.confirm(incremental); return; }
      await this.incremental.append(incremental, copies);
    });
  }
  private async load() {
    const base = await this.baseline.read();
    const marker = await optionalSourceFile(`${this.path}.initialized`);
    if ((base === undefined) !== (marker === undefined)) throw new StrigoiArchiveError("STRIGOI_MISSING_PIN_INDEX");
    const incremental = await this.incremental.load();
    if (!base && await optionalSourceFile(`${this.incremental.path}.head`) !== undefined) throw new StrigoiArchiveError("STRIGOI_MISSING_PIN_INDEX");
    return { base, incremental };
  }
}
