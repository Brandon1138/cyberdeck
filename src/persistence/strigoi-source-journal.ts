import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { StrigoiSourceRefSchema, type StrigoiSourceRef } from "../domain/strigoi.js";
import { StrigoiArchiveError } from "./strigoi-archive-error.js";
import { syncPrivateFile, writeAtomicPrivateFile } from "./atomic-private-file.js";
import { ValidatedJournal } from "./validated-journal.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const Entry = z.object({ previous: z.string(), sources: z.array(StrigoiSourceRefSchema).min(1), sha256: z.string() }).strict();
const Head = z.object({ count: z.number().int().nonnegative(), sha256: z.string() }).strict();
const emptyHash = hash([]);
export const sourceRevisionKey = (s: Pick<StrigoiSourceRef, "kind" | "id" | "revision">) => JSON.stringify([s.kind, s.id, s.revision]);
export async function optionalSourceFile(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
}
export function validateArchivedSources(sources: StrigoiSourceRef[]) {
  if (sources.some((s) => !s.copy || !s.coverageSourceId || !s.sessionIds || s.part === undefined || !s.sha256 || s.text !== undefined)) {
    throw new StrigoiArchiveError("STRIGOI_CORRUPT_PINS");
  }
}
interface Projection { sources: StrigoiSourceRef[]; keys: Set<string>; hashes: string[] }
function advance(state: Projection, value: unknown): Projection {
  try {
    const entry = Entry.parse(value);
    validateArchivedSources(entry.sources);
    if (entry.previous !== (state.hashes.at(-1) ?? emptyHash)
      || entry.sha256 !== hash({ previous: entry.previous, sources: entry.sources })) throw new Error("Invalid chain");
    state.sources.push(...entry.sources); entry.sources.forEach((s) => state.keys.add(sourceRevisionKey(s)));
    state.hashes.push(entry.sha256); return state;
  } catch { throw new StrigoiArchiveError("STRIGOI_CORRUPT_PINS"); }
}

/** A frozen v1 snapshot plus fsynced incremental records. The small durable head detects
 * missing/truncated initialized journals. A valid tail beyond the head is an ambiguous
 * append, conservatively retained and re-synced before any retry reports success.
 * The log is mutable on disk: every append invalidates the generic projection and the
 * next load validates ALL bytes, chain links and the old durable head before advancing
 * it. Unchanged reads may reuse validation; no prefix is inferred from append metadata.
 * Writes remain incremental; cumulative replay reads/parsing are quadratic in captures.
 * Avoiding those reads requires a separately designed authenticated immutable segment
 * format, not an assumption that only this process can edit the inode. */
export class StrigoiSourceJournal {
  readonly path: string;
  private readonly journal: ValidatedJournal<Projection>;
  constructor(private readonly basePath: string) {
    this.path = `${basePath}l`;
    this.journal = new ValidatedJournal(this.path, (body) => {
      const state: Projection = { sources: [], keys: new Set(), hashes: [] };
      if (body && !body.endsWith("\n")) throw new StrigoiArchiveError("STRIGOI_CORRUPT_PINS");
      for (const line of body.split("\n").filter(Boolean)) {
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { throw new StrigoiArchiveError("STRIGOI_CORRUPT_PINS"); }
        advance(state, entry);
      }
      return state;
    });
  }
  async load(): Promise<Projection> {
    const marker = await optionalSourceFile(`${this.basePath}.initialized`);
    const headBody = await optionalSourceFile(`${this.path}.head`);
    const bodyPresent = await optionalSourceFile(`${this.path}.initialized`);
    if ((marker !== undefined && marker !== "1\n" && marker !== "2\n")
      || (bodyPresent !== undefined && bodyPresent !== "1\n")) throw new StrigoiArchiveError("STRIGOI_CORRUPT_PINS");
    if (headBody === undefined) {
      if (marker === "2\n" || bodyPresent !== undefined || await optionalSourceFile(this.path) !== undefined) throw new StrigoiArchiveError("STRIGOI_MISSING_PIN_INDEX");
      return { sources: [], keys: new Set(), hashes: [] };
    }
    // Missing initialized data must never project as an empty journal.
    if (await optionalSourceFile(`${this.path}.initialized`) === undefined) throw new StrigoiArchiveError("STRIGOI_MISSING_PIN_INDEX");
    await stat(this.path).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") throw new StrigoiArchiveError("STRIGOI_MISSING_PIN_INDEX"); throw e; });
    const state = await this.journal.read();
    try {
      const head = Head.parse(JSON.parse(headBody));
      if (head.count > state.hashes.length || head.sha256 !== (head.count ? state.hashes[head.count - 1] : emptyHash)) throw new Error("Head mismatch");
    } catch { throw new StrigoiArchiveError("STRIGOI_CORRUPT_PINS"); }
    return state;
  }
  async initialize(): Promise<void> {
    if (await optionalSourceFile(`${this.path}.head`) !== undefined) return;
    // A legacy snapshot/marker may be visible after an earlier ambiguous rename.
    await syncPrivateFile(this.basePath);
    await syncPrivateFile(`${this.basePath}.initialized`);
    await writeAtomicPrivateFile(this.path, "");
    await writeAtomicPrivateFile(`${this.path}.initialized`, "1\n");
    await this.confirm({ sources: [], keys: new Set(), hashes: [] });
    await writeAtomicPrivateFile(`${this.basePath}.initialized`, "2\n");
  }
  async append(state: Projection, sources: StrigoiSourceRef[]): Promise<void> {
    const previous = state.hashes.at(-1) ?? emptyHash;
    const entry = { previous, sources, sha256: hash({ previous, sources }) };
    await this.journal.append(entry);
    // This append has already fsynced the initialized inode. Only the small head
    // remains to commit; retries of an ambiguous append use confirm() below.
    await this.writeHead(await this.load());
  }
  async confirm(state: Projection): Promise<void> {
    await syncPrivateFile(this.path);
    await this.writeHead(state);
  }
  private async writeHead(state: Projection): Promise<void> {
    await writeAtomicPrivateFile(`${this.path}.head`, JSON.stringify({ count: state.hashes.length, sha256: state.hashes.at(-1) ?? emptyHash }) + "\n");
  }
}
