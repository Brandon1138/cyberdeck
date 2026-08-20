import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { SessionRuntime } from "../domain/session-runtime.js";
import type { ProviderLaunchSpec } from "../providers/provider.js";

type OutputListener = (chunk: Buffer) => void;
type ExitListener = (exitCode: number, signal?: number) => void;

const REPLAY_BLOCK_BYTES = 16 * 1024;

interface ReplayChunk {
  readonly data: Buffer;
  length: number;
  next?: ReplayChunk;
}

export class PtyReplayBuffer {
  private head: ReplayChunk | undefined;
  private tail: ReplayChunk | undefined;
  private headOffset = 0;
  private retainedBytes = 0;

  constructor(private readonly capacity: number) {}

  append(data: Buffer): void {
    if (data.length === 0 || this.capacity <= 0) return;

    // Bytes before the final capacity cannot survive this append. Skip them before allocating
    // blocks so a tiny replay cap cannot amplify one large callback into transient allocations.
    let offset = Math.max(0, data.length - this.capacity);
    while (offset < data.length) {
      if (!this.tail || this.tail.length === this.tail.data.length) {
        const chunk: ReplayChunk = {
          data: Buffer.allocUnsafe(Math.min(REPLAY_BLOCK_BYTES, this.capacity)),
          length: 0,
        };
        if (this.tail) {
          this.tail.next = chunk;
        } else {
          this.head = chunk;
        }
        this.tail = chunk;
      }

      const available = this.tail.data.length - this.tail.length;
      const copied = data.copy(
        this.tail.data,
        this.tail.length,
        offset,
        Math.min(offset + available, data.length),
      );
      this.tail.length += copied;
      this.retainedBytes += copied;
      offset += copied;
    }

    let overflow = this.retainedBytes - this.capacity;
    while (this.head && overflow > 0) {
      const available = this.head.length - this.headOffset;
      if (overflow < available) {
        this.headOffset += overflow;
        this.retainedBytes -= overflow;
        break;
      }
      overflow -= available;
      this.retainedBytes -= available;
      this.head = this.head.next;
      this.headOffset = 0;
    }
    if (!this.head) this.tail = undefined;
  }

  snapshot(): Buffer {
    const replay = Buffer.allocUnsafe(this.retainedBytes);
    let offset = 0;
    let chunk = this.head;
    while (chunk) {
      const start = chunk === this.head ? this.headOffset : 0;
      offset += chunk.data.copy(replay, offset, start, chunk.length);
      chunk = chunk.next;
    }
    return replay;
  }
}

export class PtyProcess implements SessionRuntime {
  private readonly terminal: IPty;
  private readonly outputListeners = new Set<OutputListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly replay: PtyReplayBuffer;
  private exited = false;

  readonly pid: number;

  constructor(
    launchSpec: ProviderLaunchSpec,
    replayBytes: number,
  ) {
    this.replay = new PtyReplayBuffer(replayBytes);
    this.terminal = pty.spawn(launchSpec.executable, launchSpec.args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: launchSpec.cwd,
      env: launchSpec.env,
    });
    this.pid = this.terminal.pid;

    this.terminal.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      this.replay.append(chunk);
      for (const listener of this.outputListeners) {
        listener(chunk);
      }
    });

    this.terminal.onExit(({ exitCode, signal }) => {
      if (this.exited) return;
      this.exited = true;
      for (const listener of this.exitListeners) {
        listener(exitCode, signal);
      }
    });
  }

  write(data: Buffer): void {
    this.terminal.write(data.toString("utf8"));
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  snapshot(): Buffer {
    return this.replay.snapshot();
  }

  kill(signal?: string): void {
    if (this.exited) return;
    this.terminal.kill(signal);
  }

  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
}
