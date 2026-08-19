/** Bytes emitted by one active session runtime. */
export type SessionRuntimeOutputListener = (chunk: Buffer) => void;

/** Process termination observed by one active session runtime. */
export type SessionRuntimeExitListener = (exitCode: number, signal?: number) => void;

/**
 * Provider-neutral capabilities Cyberdeck needs from an active session runtime.
 *
 * Construction is deliberately outside this handle: current implementations start eagerly, so a
 * factory either returns a fully active runtime or throws. Keeping that boundary preserves launch
 * timing and error semantics while allowing PTY and pipe transports to remain outer-layer details.
 */
export interface SessionRuntime {
  readonly pid: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  snapshot(): Buffer;
  kill(signal?: string): void;
  onOutput(listener: SessionRuntimeOutputListener): () => void;
  onExit(listener: SessionRuntimeExitListener): () => void;
}

/** Eagerly starts one session runtime from an outer-layer launch description. */
export type SessionRuntimeFactory<LaunchSpec> = (
  spec: LaunchSpec,
  replayBytes: number,
) => SessionRuntime;
