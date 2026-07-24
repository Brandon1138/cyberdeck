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
  /** Durable identity whose explicit control detach should be eligible for Fleet reattachment. */
  detachIdentity?: string;
  /** Presentation callback invoked only after an explicit keyboard detach has released control. */
  onExplicitDetach?: (() => void | Promise<void>) | undefined;
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
    let pendingInput = Buffer.alloc(0);
    let pendingEscapeTimer: ReturnType<typeof setTimeout> | undefined;

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
      if (pendingEscapeTimer !== undefined) clearTimeout(pendingEscapeTimer);
      pendingEscapeTimer = undefined;
      pendingInput = Buffer.alloc(0);
      if (options.closeTransport !== false) options.transport.close();
    };

    const finish = (code: number, sendDetach: boolean) => {
      if (finished) return;
      const complete = () => {
        if (!sendDetach || options.onExplicitDetach === undefined) {
          resolve(code);
          return;
        }
        void Promise.resolve(options.onExplicitDetach()).then(() => resolve(code)).catch(reject);
      };
      if (sendDetach && options.detachIdentity !== undefined) {
        cleanup();
        void options.transport.request("session.detach", { sessionId: options.sessionId })
          .then(complete)
          .catch(reject);
        return;
      }
      if (sendDetach) {
        options.transport.sendFrame({ type: "detach", sessionId: options.sessionId });
      }
      cleanup();
      complete();
    };

    const sendInput = (chunk: Buffer) => {
      if (chunk.length === 0 || finished) return;
      options.transport.sendFrame({
        type: "input",
        sessionId: options.sessionId,
        data: chunk.toString("base64"),
      });
    };

    const schedulePendingEscape = () => {
      if (pendingEscapeTimer !== undefined) clearTimeout(pendingEscapeTimer);
      pendingEscapeTimer = setTimeout(() => {
        pendingEscapeTimer = undefined;
        const pending = pendingInput;
        pendingInput = Buffer.alloc(0);
        if (pending.equals(Buffer.from([0x1b]))) {
          finish(0, true);
        } else {
          sendInput(pending);
        }
      }, 25);
    };

    const onInput = (value: Buffer | string) => {
      if (finished) return;
      if (pendingEscapeTimer !== undefined) clearTimeout(pendingEscapeTimer);
      pendingEscapeTimer = undefined;
      pendingInput = Buffer.concat([
        pendingInput,
        Buffer.isBuffer(value) ? value : Buffer.from(value),
      ]);

      while (pendingInput.length > 0 && !finished) {
        const escapeIndex = pendingInput.indexOf(0x1b);
        const reattachIndex = pendingInput.indexOf(0x1d);
        const controlIndex = escapeIndex === -1
          ? reattachIndex
          : reattachIndex === -1
            ? escapeIndex
            : Math.min(escapeIndex, reattachIndex);
        if (controlIndex === -1) {
          sendInput(pendingInput);
          pendingInput = Buffer.alloc(0);
          return;
        }
        sendInput(pendingInput.subarray(0, controlIndex));
        pendingInput = pendingInput.subarray(controlIndex);

        // Ctrl+] belongs to Fleet reattachment. While attached it is consumed as a strict no-op.
        if (pendingInput[0] === 0x1d) {
          pendingInput = pendingInput.subarray(1);
          continue;
        }

        // A following control byte cannot form an Alt/escape sequence. Honor the standalone Ctrl+[
        // immediately and consume everything after it with the attachment teardown.
        if (pendingInput.length > 1 && pendingInput[1]! < 0x20) {
          finish(0, true);
          return;
        }

        const escapeLength = completeEscapeSequenceLength(pendingInput);
        if (escapeLength === undefined) {
          schedulePendingEscape();
          return;
        }
        const sequence = pendingInput.subarray(0, escapeLength);
        pendingInput = pendingInput.subarray(escapeLength);
        if (isControlLeftBracket(sequence)) {
          finish(0, true);
          return;
        }
        if (sequence.equals(Buffer.from("\u001b[D")) && detachOnLeftArrow) {
          finish(0, true);
          return;
        }
        sendInput(sequence);
      }
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
    }>(method, {
      sessionId: options.sessionId,
      ...(options.detachIdentity === undefined ? {} : { detachIdentity: options.detachIdentity }),
    })
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

function completeEscapeSequenceLength(input: Buffer): number | undefined {
  if (input.length < 2) return undefined;
  if (input[1] === 0x5b) {
    for (let index = 2; index < input.length; index += 1) {
      const byte = input[index]!;
      if (byte >= 0x40 && byte <= 0x7e) return index + 1;
    }
    return undefined;
  }
  if (input[1] === 0x4f) return input.length >= 3 ? 3 : undefined;
  return 2;
}

function isControlLeftBracket(input: Buffer): boolean {
  const sequence = input.toString("ascii");
  return /^\u001b\[(?:91(?::[0-9:]*)?;5(?::[0-9]+)?(?:;[0-9:]+)?u|27;5;91~)$/u.test(sequence);
}
