import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { InstructionRecordSchema, type InstructionRecord } from "../domain/instruction.js";

export type InstructionQuery = "all" | "unsettled" | { id: string } | { target: string };
type Helper = ChildProcessByStdio<Writable, Readable, null>;
type Pending = {
  records: InstructionRecord[];
  resolve: (records: InstructionRecord[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** One in-flight request per store, serialized by the journal alongside local fsyncs. */
export class NativeInstructionIndex {
  private helper: Helper | undefined;
  private pending: Pending | undefined;
  private retryAfter = 0;
  private warned = false;
  constructor(private readonly path: string) {}

  async read(query: InstructionQuery): Promise<InstructionRecord[] | undefined> {
    if (Date.now() < this.retryAfter) return undefined;
    try {
      const helper = this.helper ?? this.start();
      // The Rust process owns no journal writes. A lost terminal frame discards the whole response.
      return await new Promise<InstructionRecord[]>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(helper), 30_000);
        this.pending = { resolve, reject, records: [], timer };
        helper.stdin.write(JSON.stringify(query) + "\n", (error) => {
          if (error) this.fail(helper);
        });
      });
    } catch {
      this.retryAfter = Math.max(this.retryAfter, Date.now() + 30_000);
      if (!this.warned)
        console.warn("Cyberdeck instruction index unavailable. Reading the journal in TypeScript.");
      this.warned = true;
      return undefined;
    }
  }

  private start(): Helper {
    const binary = fileURLToPath(
      new URL(`../../native/bin/${process.platform}-${process.arch}/cyberdeck-index`, import.meta.url),
    );
    const child = spawn(binary, [this.path], { stdio: ["pipe", "pipe", "ignore"] });
    this.helper = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("error", () => this.fail(child));
    lines.on("line", (line) => {
      const pending = this.pending;
      if (this.helper !== child || !pending) return;
      try {
        if (line === "null") {
          clearTimeout(pending.timer);
          this.pending = undefined;
          pending.resolve(pending.records);
        } else {
          pending.records.push(InstructionRecordSchema.parse(JSON.parse(line)));
        }
      } catch {
        this.fail(child);
      }
    });
    for (const emitter of [child.stdin, child.stdout]) emitter.on("error", () => this.fail(child));
    child.on("error", () => this.fail(child));
    // close follows stdout drainage, including complete replies preceding a clean exit.
    child.on("close", () => this.fail(child));
    // Idle IPC must never keep a terminating Node process alive. The request timer
    // keeps an active query alive and stdin EOF releases the helper on parent death.
    child.unref();
    for (const pipe of [child.stdin, child.stdout]) {
      if ("unref" in pipe && typeof pipe.unref === "function") pipe.unref();
    }
    return child;
  }

  close(): void {
    this.retryAfter = Infinity;
    if (this.helper) this.fail(this.helper);
  }

  private fail(child: Helper): void {
    if (this.helper !== child) return;
    this.helper = undefined;
    child.stdin.destroy();
    child.stdout.destroy();
    child.kill();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("Instruction index interrupted"));
      this.pending = undefined;
    }
  }
}
