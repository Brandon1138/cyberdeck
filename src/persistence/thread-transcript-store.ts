import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ThreadEventSchema,
  type ThreadEvent,
  type ThreadEventKind,
  type ThreadEventSource,
  type ThreadReadResult,
} from "../domain/thread.js";

export interface AppendThreadEvent {
  sessionId: string;
  kind: ThreadEventKind;
  source: ThreadEventSource;
  text?: string;
  data?: Record<string, unknown>;
}

export interface ThreadTranscriptStoreOptions {
  now?: () => string;
  idFactory?: () => string;
}

/**
 * A local, append-only transcript shared by all interactive threads.
 *
 * Cursors are global and monotonic, allowing an orchestrator to ask for every change since its last
 * observation without polling and diffing bounded PTY replay buffers. The file is user-readable
 * only and every append is fsynced before it resolves.
 */
export class ThreadTranscriptStore {
  readonly path: string;
  private readonly events: ThreadEvent[] = [];
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private writeTail = Promise.resolve();

  constructor(
    stateDirectory: string,
    private readonly options: ThreadTranscriptStoreOptions = {},
  ) {
    this.path = join(stateDirectory, "threads", "transcript.jsonl");
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization !== undefined) return this.initialization;
    this.initialization = this.load();
    await this.initialization;
    this.initialized = true;
  }

  async append(input: AppendThreadEvent): Promise<ThreadEvent> {
    await this.init();
    const event = ThreadEventSchema.parse({
      id: this.options.idFactory?.() ?? randomUUID(),
      cursor: (this.events.at(-1)?.cursor ?? 0) + 1,
      sessionId: input.sessionId,
      occurredAt: this.options.now?.() ?? new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      ...(input.text === undefined ? {} : { text: input.text }),
      data: input.data ?? {},
    });
    this.events.push(event);
    this.writeTail = this.writeTail.then(() => this.persist(event));
    await this.writeTail;
    return event;
  }

  async read(sessionId: string, afterCursor = 0, limit = 200): Promise<ThreadReadResult> {
    await this.init();
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const events = this.events
      .filter((event) => event.sessionId === sessionId && event.cursor > afterCursor)
      .slice(0, boundedLimit);
    return { events, nextCursor: events.at(-1)?.cursor ?? afterCursor };
  }

  async changes(afterCursor = 0, limit = 500): Promise<ThreadReadResult> {
    await this.init();
    const boundedLimit = Math.max(1, Math.min(limit, 2_000));
    const events = this.events.filter((event) => event.cursor > afterCursor).slice(0, boundedLimit);
    return { events, nextCursor: events.at(-1)?.cursor ?? afterCursor };
  }

  private async load(): Promise<void> {
    const content = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const lines = content.split("\n");
    if (!content.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (line.trim() === "") continue;
      this.events.push(ThreadEventSchema.parse(JSON.parse(line)));
    }
  }

  private async persist(event: ThreadEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

