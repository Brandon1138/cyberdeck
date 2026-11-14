import { withBindingAuthority } from "./binding-authority.js";
import { assertEvidenceRetainable, evidenceSafety } from "./strigoi-evidence-deletion.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { StrigoiSourceRefSchema, type StrigoiSourceRef } from "../domain/strigoi.js";
import type { StrigoiPacketPort } from "../orchestration/strigoi-ports.js";
import { writeAtomicPrivateFile } from "./atomic-private-file.js";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const IndexSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(StrigoiSourceRefSchema), sha256: z.string() }).strict();
/** Evidence index only: it confers no delivery, consumption, lease or controller authority. */
export class StrigoiSourceArchive {
  readonly path: string;
  constructor(private readonly directory: string, private readonly packets: StrigoiPacketPort) { this.path = join(directory, "orchestration", "strigoi", "sources.json"); }
  async list(): Promise<StrigoiSourceRef[]> {
    return withBindingAuthority(this.directory, () => this.load());
  }
  async pins(): Promise<ReadonlySet<string>> { return new Set([...(await evidenceSafety(this.directory)).retainedSessionIds, ...(await this.list()).flatMap((s) => s.sessionIds ?? [])]); }
  capture(kind: StrigoiSourceRef["kind"], id: string, value: unknown, sessionIds: string[]): Promise<void> {
    const text = typeof value === "string" ? value : JSON.stringify(value), revision = digest(text);
    return withBindingAuthority(this.directory, async () => {
      await assertEvidenceRetainable(this.directory, sessionIds);
      const sources = await this.load();
      if (sources.some((s) => s.kind === kind && s.id === id && s.revision === revision)) return;
      if (sources.length === 0) {
        await writeAtomicPrivateFile(this.path, JSON.stringify({ schemaVersion: 1, sources, sha256: digest(JSON.stringify(sources)) }) + "\n");
        await writeAtomicPrivateFile(`${this.path}.initialized`, "1\n");
      }
      sources.push(...await this.packets.copy({ kind, id, revision }, text, sessionIds));
      await writeAtomicPrivateFile(this.path, JSON.stringify({ schemaVersion: 1, sources, sha256: digest(JSON.stringify(sources)) }) + "\n");
    });
  }
  private async load(): Promise<StrigoiSourceRef[]> {
    const body = await readFile(this.path, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
    if (body === undefined) {
      const initialized = await readFile(`${this.path}.initialized`, "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
      if (initialized !== undefined) throw new Error("STRIGOI_MISSING_PIN_INDEX");
      return [];
    }
    try {
      const index = IndexSchema.parse(JSON.parse(body));
      if (index.sha256 !== digest(JSON.stringify(index.sources)) || index.sources.some((s) => !s.copy || !s.coverageSourceId || !s.sessionIds)) throw new Error("Incomplete index");
      return index.sources;
    } catch { throw new Error("STRIGOI_CORRUPT_PINS"); }
  }
}
