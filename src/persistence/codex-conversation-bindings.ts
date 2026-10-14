import { readFile, readdir, rm, stat } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomicPrivateFile } from "./atomic-private-file.js";

const BindingSchema = z.object({
  sessionId: z.uuid(), nativeSessionId: z.string().min(1), transcriptPath: z.string().min(1),
  cwd: z.string().min(1),
  launchIdentity: z.object({ id: z.string().min(1), textHash: z.string().regex(/^[0-9a-f]{64}$/u).optional() }).strict().optional(),
}).strict();
export type CodexConversationBinding = z.infer<typeof BindingSchema>;

/** Exact provider identity survives restart independently of semantic journal rotation. */
export class CodexConversationBindingStore {
  readonly directory: string;
  constructor(stateDirectory: string) { this.directory = join(stateDirectory, "threads", "codex-conversations"); }
  private path(sessionId: string): string { return join(this.directory, `${z.uuid().parse(sessionId)}.json`); }
  async record(binding: CodexConversationBinding): Promise<void> {
    await writeAtomicPrivateFile(this.path(binding.sessionId), JSON.stringify(BindingSchema.parse(binding)) + "\n");
  }
  async read(sessionId: string): Promise<CodexConversationBinding | undefined> {
    const contents = await readFile(this.path(sessionId), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    return this.parse(contents, sessionId);
  }
  /** Provider specs are synchronous. This reads only one small durable identity record. */
  readSync(sessionId: string): CodexConversationBinding | undefined {
    try { return this.parse(readFileSync(this.path(sessionId), "utf8"), sessionId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async remove(sessionId: string): Promise<void> { await rm(this.path(sessionId), { force: true }); }
  async exists(sessionId: string): Promise<boolean> {
    return stat(this.path(sessionId)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  }
  async claimants(nativeSessionId: string): Promise<string[]> {
    const entries = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const bindings = await Promise.all(entries.filter((name) => name.endsWith(".json") && z.uuid().safeParse(name.slice(0, -5)).success)
      .map((name) => this.read(name.slice(0, -5))));
    return bindings.filter((binding) => binding?.nativeSessionId === nativeSessionId).map((binding) => binding!.sessionId);
  }
  claimantsSync(nativeSessionId: string): string[] {
    let entries: string[];
    try { entries = readdirSync(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return entries.filter((name) => name.endsWith(".json") && z.uuid().safeParse(name.slice(0, -5)).success)
      .flatMap((name) => {
        const binding = this.readSync(name.slice(0, -5));
        return binding?.nativeSessionId === nativeSessionId ? [binding.sessionId] : [];
      });
  }
  private parse(contents: string | undefined, sessionId: string): CodexConversationBinding | undefined {
    if (contents === undefined) return undefined;
    try {
      const result = BindingSchema.safeParse(JSON.parse(contents));
      return result.success && result.data.sessionId === sessionId ? result.data : undefined;
    } catch { return undefined; }
  }
}
