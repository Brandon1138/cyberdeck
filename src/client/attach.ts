import type { ClientFrame, ServerFrame } from "../protocol/frames.js";

export interface AttachTransport {
  request<T>(method: string, params: unknown): Promise<T>;
  sendFrame(frame: ClientFrame): void;
  onFrame(listener: (frame: ServerFrame) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

interface TerminalInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (raw: boolean) => unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?: () => unknown;
  pause?: () => unknown;
}

interface TerminalOutput {
  columns?: number;
  rows?: number;
  write(chunk: string | Uint8Array): unknown;
}

interface SignalSource {
  on(event: "SIGWINCH", listener: () => void): unknown;
  off(event: "SIGWINCH", listener: () => void): unknown;
}

export interface AttachSessionOptions {
  sessionId: string;
  mode: "control" | "watch";
  transport: AttachTransport;
  input?: TerminalInput;
  output?: TerminalOutput;
  signals?: SignalSource;
  /** Keep a shared transport alive when returning to an enclosing client such as the fleet. */
  closeTransport?: boolean;
  /** Workers use Left Arrow as directional return. Orchestrators keep it for native TUI input. */
  detachOnLeftArrow?: boolean;
}

export async function attachSession(options: AttachSessionOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const signals = options.signals ?? process;
  if (options.mode === "control" && input.isTTY !== true) {
    throw new Error("Control attachment requires a TTY");
  }

  return new Promise<number>((resolve, reject) => {
    const liveBeforeReplay: Buffer[] = [];
    const previousRawMode = input.isRaw === true;
    let replayWritten = false;
    let rawModeChanged = false;
    let attachmentClaimed = false;
    let finished = false;
    let detachOnLeftArrow = options.detachOnLeftArrow ?? true;

    const onFrame = (frame: ServerFrame) => {
      if (frame.type === "session-ended" && frame.sessionId === options.sessionId) {
        finish(0, false);
        return;
      }
      if (frame.type !== "output" || frame.sessionId !== options.sessionId) return;
      const chunk = Buffer.from(frame.data, "base64");
      if (!replayWritten) liveBeforeReplay.push(chunk);
      else output.write(chunk);
    };
    const unsubscribeFrame = options.transport.onFrame(onFrame);

    const cleanup = () => {
      if (finished) return;
      finished = true;
      unsubscribeFrame();
      unsubscribeClose();
      input.off("data", onInput);
      signals.off("SIGWINCH", onResize);
      input.pause?.();
      if (rawModeChanged) input.setRawMode?.(previousRawMode);
      if (options.closeTransport !== false) options.transport.close();
    };

    const finish = (code: number, sendDetach: boolean) => {
      if (finished) return;
      if (sendDetach) {
        options.transport.sendFrame({ type: "detach", sessionId: options.sessionId });
      }
      cleanup();
      resolve(code);
    };

    const onInput = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const controlDetachIndex = chunk.indexOf(0x1d);
      const leftArrowIndex = detachOnLeftArrow ? chunk.indexOf(Buffer.from("\u001b[D")) : -1;
      const detachIndex = controlDetachIndex === -1
        ? leftArrowIndex
        : leftArrowIndex === -1
          ? controlDetachIndex
          : Math.min(controlDetachIndex, leftArrowIndex);
      const forwarded = detachIndex === -1 ? chunk : chunk.subarray(0, detachIndex);
      if (forwarded.length > 0) {
        options.transport.sendFrame({
          type: "input",
          sessionId: options.sessionId,
          data: forwarded.toString("base64"),
        });
      }
      if (detachIndex !== -1) finish(0, true);
    };

    const onResize = () => {
      const cols = output.columns;
      const rows = output.rows;
      if (cols === undefined || rows === undefined || cols <= 0 || rows <= 0) return;
      options.transport.sendFrame({
        type: "resize",
        sessionId: options.sessionId,
        cols,
        rows,
      });
    };

    const unsubscribeClose = options.transport.onClose(() => finish(1, false));
    const method = options.mode === "control" ? "session.attach" : "session.watch";
    void options.transport.request<{
      data: string;
      session?: { kind?: "worker" | "orchestrator" };
    }>(method, { sessionId: options.sessionId })
      .then(({ data, session }) => {
        if (finished) return;
        attachmentClaimed = true;
        detachOnLeftArrow = options.detachOnLeftArrow ?? (session?.kind !== "orchestrator");
        output.write(Buffer.from(data, "base64"));
        replayWritten = true;
        for (const chunk of liveBeforeReplay) output.write(chunk);
        liveBeforeReplay.length = 0;

        if (options.mode === "control") {
          input.setRawMode?.(true);
          rawModeChanged = true;
          input.on("data", onInput);
          signals.on("SIGWINCH", onResize);
          input.resume?.();
          onResize();
        }
      })
      .catch((error: unknown) => {
        if (attachmentClaimed) {
          options.transport.sendFrame({ type: "detach", sessionId: options.sessionId });
        }
        cleanup();
        reject(error);
      });
  });
}
