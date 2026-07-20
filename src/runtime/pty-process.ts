import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { ProviderLaunchSpec } from "../providers/provider.js";

type OutputListener = (chunk: Buffer) => void;
type ExitListener = (exitCode: number, signal?: number) => void;

export class PtyProcess {
  private readonly terminal: IPty;
  private readonly outputListeners = new Set<OutputListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private replay = Buffer.alloc(0);
  private exited = false;

  readonly pid: number;

  constructor(
    launchSpec: ProviderLaunchSpec,
    private readonly replayBytes: number,
  ) {
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
      this.replay = Buffer.concat([this.replay, chunk]);
      if (this.replay.length > this.replayBytes) {
        this.replay = this.replay.subarray(this.replay.length - this.replayBytes);
      }
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
    return Buffer.from(this.replay);
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
