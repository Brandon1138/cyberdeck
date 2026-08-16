import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory } from "./private-files.js";

/**
 * Claude's SessionStart hook fires for `startup`, `resume`, `clear` and `compact`. `clear` is the
 * one this store exists for: it is the only moment at which Claude itself names the file the
 * conversation moved to, from inside the very process Cyberdeck launched.
 */
export const CLAUDE_CONVERSATION_SOURCES = [
  "startup",
  "resume",
  "clear",
  "compact",
] as const;

export const ClaudeConversationBindingSchema = z.object({
  /** Cyberdeck's session id — baked into the hook command at launch, never read from the payload. */
  sessionId: z.string().min(1),
  /** Claude's own conversation id for the file it is now writing. */
  nativeSessionId: z.string().min(1),
  transcriptPath: z.string().min(1),
  cwd: z.string().min(1),
  source: z.enum(CLAUDE_CONVERSATION_SOURCES),
  observedAt: z.string().min(1),
});

export type ClaudeConversationBinding = z.infer<typeof ClaudeConversationBindingSchema>;

/** The hook payload Claude writes to the command's stdin. Extra fields are ignored. */
export const ClaudeSessionStartHookPayloadSchema = z.object({
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
  source: z.enum(CLAUDE_CONVERSATION_SOURCES).optional(),
});

export type ClaudeSessionStartHookPayload = z.infer<typeof ClaudeSessionStartHookPayloadSchema>;

export interface ClaudeConversationBindingStoreOptions {
  now?: () => string;
}

/**
 * Where a Cyberdeck session's Claude conversation currently lives.
 *
 * One file per session id, written by the short-lived hook process and read by the broker, so a
 * rebind survives a broker that is down, restarting, or resuming: the signal is on disk before
 * anything in Cyberdeck has to be listening for it.
 *
 * The key is Cyberdeck's session id, which the hook command carries as an argument fixed at launch.
 * Nothing is inferred from cwd or file mtime, so two workers sharing one worktree write two
 * bindings and neither can be mistaken for the other.
 */
export class ClaudeConversationBindingStore {
  readonly directory: string;

  constructor(
    stateDirectory: string,
    private readonly options: ClaudeConversationBindingStoreOptions = {},
  ) {
    this.directory = join(stateDirectory, "threads", "claude-conversations");
  }

  async record(input: {
    sessionId: string;
    payload: ClaudeSessionStartHookPayload;
  }): Promise<ClaudeConversationBinding> {
    const binding = ClaudeConversationBindingSchema.parse({
      sessionId: input.sessionId,
      nativeSessionId: input.payload.session_id,
      transcriptPath: input.payload.transcript_path,
      cwd: input.payload.cwd,
      source: input.payload.source ?? "startup",
      observedAt: this.options.now?.() ?? new Date().toISOString(),
    });
    await ensurePrivateDirectory(this.directory);
    const path = this.bindingPath(binding.sessionId);
    // Written elsewhere and read here concurrently, so it lands whole or not at all.
    const staging = `${path}.${process.pid}.tmp`;
    await writeFile(staging, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
    await rename(staging, path);
    return binding;
  }

  async read(sessionId: string): Promise<ClaudeConversationBinding | undefined> {
    return this.readPath(this.bindingPath(sessionId));
  }

  /** Modification time of a session's binding, for callers that cache a resolved path. */
  async revision(sessionId: string): Promise<number | undefined> {
    const stats = await stat(this.bindingPath(sessionId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    return stats?.mtimeMs;
  }

  /** Drop a retired session's binding; a session id is never reused, so nothing outlives it. */
  async remove(sessionId: string): Promise<void> {
    await rm(this.bindingPath(sessionId), { force: true });
  }

  /**
   * Every session whose durable binding names `transcriptPath`.
   *
   * Answered from disk rather than from whatever a running broker happens to have claimed, so the
   * answer does not depend on read order: two bindings naming one file are a conflict for both of
   * the sessions that named it, on the first read after a restart as much as on the hundredth.
   */
  async sessionsBoundTo(transcriptPath: string): Promise<string[]> {
    const bindings = await this.list();
    return bindings
      .filter((binding) => binding.transcriptPath === transcriptPath)
      .map((binding) => binding.sessionId);
  }

  async list(): Promise<ClaudeConversationBinding[]> {
    const entries = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const bindings: ClaudeConversationBinding[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const binding = await this.readPath(join(this.directory, entry));
      if (binding !== undefined) bindings.push(binding);
    }
    return bindings;
  }

  private async readPath(path: string): Promise<ClaudeConversationBinding | undefined> {
    const contents = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (contents === undefined) return undefined;
    try {
      const parsed = ClaudeConversationBindingSchema.safeParse(JSON.parse(contents));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // A half-written or hand-edited binding is no signal at all; the caller fails closed.
      return undefined;
    }
  }

  private bindingPath(sessionId: string): string {
    return join(this.directory, `${encodeURIComponent(sessionId)}.json`);
  }
}
