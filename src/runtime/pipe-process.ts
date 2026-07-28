import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ProviderLaunchSpec } from "../providers/provider.js";
import type { PtyHandle } from "../broker/session-registry.js";

/**
 * Bounded pipe-backed process handle for provider noninteractive transports. It intentionally
 * implements the existing session runtime port so a Scout remains a normal Cyberdeck Worker while
 * avoiding a terminal emulator, prompt scraping, and synthetic keypresses.
 */
export class PipeProcess implements PtyHandle {
  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private readonly outputListeners = new Set<(chunk: Buffer) => void>();
  private readonly exitListeners = new Set<(exitCode: number, signal?: number) => void>();
  private replay = Buffer.alloc(0);
  private exited = false;
  private exitCode = 1;

  readonly pid: number;

  constructor(
    launchSpec: ProviderLaunchSpec,
    private readonly replayBytes: number,
  ) {
    this.child = spawn(launchSpec.executable, launchSpec.args, {
      cwd: launchSpec.cwd,
      env: launchSpec.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.pid = this.child.pid ?? 0;
    this.child.stdout.on("data", (value: Buffer | string) => {
      this.emit(Buffer.isBuffer(value) ? value : Buffer.from(value));
    });
    this.child.stderr.on("data", (value: Buffer | string) => {
      const body = Buffer.isBuffer(value) ? value.toString("utf8") : value;
      this.emit(Buffer.from(`${JSON.stringify({
        type: "cyberdeck_stderr",
        text: body,
      })}\n`));
    });
    this.child.on("error", (error) => {
      this.emit(Buffer.from(`${JSON.stringify({
        type: "cyberdeck_process_error",
        text: error.message,
      })}\n`));
    });
    // `close`, unlike `exit`, runs after stdout and stderr have closed. The Scout lifecycle can
    // therefore finalize its card and trace without racing the provider's last stream-json frame.
    this.child.on("close", (code) => {
      if (this.exited) return;
      this.exited = true;
      this.exitCode = code ?? 1;
      for (const listener of this.exitListeners) listener(this.exitCode);
    });
  }

  write(_data: Buffer): void {
    throw new Error("Headless Scout processes do not accept interactive input");
  }

  resize(): void {
    // Pipe transports have no terminal dimensions.
  }

  snapshot(): Buffer {
    return Buffer.from(this.replay);
  }

  kill(signal?: string): void {
    if (this.exited) return;
    this.child.kill(signal as NodeJS.Signals | undefined);
  }

  onOutput(listener: (chunk: Buffer) => void): () => void {
    this.outputListeners.add(listener);
    // A very fast one-shot provider can emit before the registry adopts the handle.
    if (this.replay.length > 0) listener(Buffer.from(this.replay));
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (exitCode: number, signal?: number) => void): () => void {
    if (this.exited) {
      queueMicrotask(() => listener(this.exitCode));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private emit(chunk: Buffer): void {
    this.replay = Buffer.concat([this.replay, chunk]);
    if (this.replay.length > this.replayBytes) {
      this.replay = this.replay.subarray(this.replay.length - this.replayBytes);
    }
    for (const listener of this.outputListeners) listener(chunk);
  }
}
