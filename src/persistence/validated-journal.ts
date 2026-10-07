import { open, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { openPrivateAppendFile } from "./private-files.js";

const version = (info: BigIntStats): string =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;

/**
 * Cache a validated projection, never authority on a timer. Every read opens the current path
 * and checks descriptor AND path identity. Any external change (including append, same-size
 * rewrite, replacement, truncation or deletion) requires a complete revalidation. An external
 * append cannot safely be treated as append-only: its writer may also have edited the prefix.
 * Reads and our fsynced appends share a queue; failed parsing never publishes a partial cache.
 */
export class ValidatedJournal<T> {
  private tail = Promise.resolve();
  private cached: { version: string; projection: T } | undefined;
  constructor(private readonly path: string, private readonly project: (content: string) => T) {}

  read(): Promise<T> {
    return this.enqueue(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const file = await open(this.path, "r").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (file === undefined) {
          this.cached = undefined;
          return this.project("");
        }
        try {
          const before = version(await file.stat({ bigint: true }));
          const projection = this.cached?.version === before
            ? this.cached.projection
            : this.project(await file.readFile("utf8"));
          const after = version(await file.stat({ bigint: true }));
          const current = await stat(this.path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (before !== after || current === undefined || after !== version(current)) continue;
          this.cached = { version: after, projection };
          return projection;
        } finally { await file.close(); }
      }
      throw new Error("Journal changed during validation");
    });
  }

  append(record: unknown): Promise<void> {
    return this.enqueue(async () => {
      const handle = await openPrivateAppendFile(this.path);
      try {
        await handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
        await handle.sync();
      } finally {
        this.cached = undefined;
        await handle.close();
      }
    });
  }

  private enqueue<R>(work: () => Promise<R>): Promise<R> {
    const operation = this.tail.then(work);
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }
}
