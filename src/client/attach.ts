import type { ClientFrame, ServerFrame } from "../protocol/frames.js";

export interface AttachTransport {
  request<T>(method: string, params: unknown): Promise<T>;
  sendFrame(frame: ClientFrame): void;
  onFrame(listener: (frame: ServerFrame) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

/**
 * Ctrl+] is the single reserved chord while attached. Esc and every Alt/Meta chord that starts with
 * Esc belong to the provider TUI, so no detach may ever be bound to byte 0x1b.
 */
const DETACH_BYTE = 0x1d;
const ESCAPE_BYTE = 0x1b;
/**
 * A bracketed paste carries data, not keystrokes. Its payload is forwarded opaquely so that a pasted
 * `0x1d` or a pasted Left Arrow cannot be mistaken for the detach chord or the directional return.
 */
const PASTE_START = Buffer.from("\u001b[200~");
const PASTE_END = Buffer.from("\u001b[201~");
const LEFT_ARROW = Buffer.from("\u001b[D");
/**
 * Only wide enough to reunite an escape sequence split across reads. Expiry now forwards the pending
 * bytes verbatim, so a slow or remote link degrades to a real keystroke instead of a surprise detach.
 */
const ESCAPE_COALESCE_MS = 25;

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
  /**
   * Workers use Left Arrow as directional return. Orchestrators keep it for native TUI input and
   * detach with Ctrl+], which is reserved for both kinds.
   */
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
    let transportClosed = false;
    let detachOnLeftArrow = options.detachOnLeftArrow ?? true;
    let pendingInput = Buffer.alloc(0);
    let pendingEscapeTimer: ReturnType<typeof setTimeout> | undefined;
    /** Bytes of the paste terminator matched so far, carried across reads while a paste is open. */
    let insidePaste = false;
    let pasteEndMatched = 0;

    const onFrame = (frame: ServerFrame) => {
      if (frame.type === "session-ended" && frame.sessionId === options.sessionId) {
        finish(0, false);
        return;
      }
      if (frame.type === "session-failed" && frame.sessionId === options.sessionId) {
        output.write(`\r\nCyberdeck ${frame.code}: ${frame.message}\r\n`);
        finish(1, false);
        return;
      }
      if (frame.type === "protocol-error") {
        output.write(`\r\nCyberdeck ${frame.code}: ${frame.message}\r\n`);
        finish(1, false);
        return;
      }
      if (frame.type !== "output" || frame.sessionId !== options.sessionId) return;
      const chunk = Buffer.from(frame.data, "base64");
      if (!replayWritten) liveBeforeReplay.push(chunk);
      else output.write(chunk);
    };
    const unsubscribeFrame = options.transport.onFrame(onFrame);

    /**
     * Hand the terminal back and stop speaking for this attachment. Kept apart from closing the
     * transport, because a detach still has to travel over it.
     */
    const releaseTerminal = () => {
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
    };

    const closeTransport = () => {
      if (transportClosed || options.closeTransport === false) return;
      transportClosed = true;
      options.transport.close();
    };

    const cleanup = () => {
      releaseTerminal();
      closeTransport();
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
        // Only the terminal is released up front. Closing the transport first ended the socket out
        // from under this request, so the broker never heard the detach and went on holding control
        // for an attachment that was already gone — the session could not be reattached.
        releaseTerminal();
        void options.transport.request("session.detach", { sessionId: options.sessionId })
          .then(() => {
            closeTransport();
            complete();
          })
          .catch((error: unknown) => {
            closeTransport();
            reject(error);
          });
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

    /** Wait once for the rest of a split escape sequence, then hand whatever arrived to the provider. */
    const schedulePendingEscape = () => {
      if (pendingEscapeTimer !== undefined) clearTimeout(pendingEscapeTimer);
      pendingEscapeTimer = setTimeout(() => {
        pendingEscapeTimer = undefined;
        const pending = pendingInput;
        pendingInput = Buffer.alloc(0);
        sendInput(pending);
      }, ESCAPE_COALESCE_MS);
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
        // A paste is opaque. Its payload is forwarded as fast as it arrives and no chord inside it
        // is recognized, so pasted text that happens to contain 0x1d or a cursor sequence is data.
        if (insidePaste) {
          const terminator = pasteTerminatorEnd(pendingInput, pasteEndMatched);
          if (terminator.endIndex === undefined) {
            pasteEndMatched = terminator.matched;
            sendInput(pendingInput);
            pendingInput = Buffer.alloc(0);
            return;
          }
          sendInput(pendingInput.subarray(0, terminator.endIndex));
          pendingInput = pendingInput.subarray(terminator.endIndex);
          insidePaste = false;
          pasteEndMatched = 0;
          continue;
        }

        if (pendingInput.subarray(0, PASTE_START.length).equals(PASTE_START)) {
          sendInput(pendingInput.subarray(0, PASTE_START.length));
          pendingInput = pendingInput.subarray(PASTE_START.length);
          insidePaste = true;
          pasteEndMatched = 0;
          continue;
        }

        // Ctrl+] is the detach chord. Nothing after it survives the attachment teardown, and a copy
        // of the byte that sits inside a paste later in this read is payload rather than a chord.
        const pasteIndex = pendingInput.indexOf(PASTE_START);
        const detachIndex = pendingInput.indexOf(DETACH_BYTE);
        if (detachIndex !== -1 && (pasteIndex === -1 || detachIndex < pasteIndex)) {
          sendInput(pendingInput.subarray(0, detachIndex));
          pendingInput = Buffer.alloc(0);
          finish(0, true);
          return;
        }

        // An orchestrator reserves no escape sequence, so its bytes are never held back or parsed.
        if (!detachOnLeftArrow) {
          sendInput(pendingInput);
          pendingInput = Buffer.alloc(0);
          return;
        }

        const escapeIndex = pendingInput.indexOf(ESCAPE_BYTE);
        if (escapeIndex === -1) {
          sendInput(pendingInput);
          pendingInput = Buffer.alloc(0);
          return;
        }
        sendInput(pendingInput.subarray(0, escapeIndex));
        pendingInput = pendingInput.subarray(escapeIndex);

        // Left Arrow is the only reserved sequence, so only its own strict prefixes wait for more
        // bytes. A bare Esc resolves after one coalescing window; every other chord resolves now.
        if (
          pendingInput.length < LEFT_ARROW.length
          && LEFT_ARROW.subarray(0, pendingInput.length).equals(pendingInput)
        ) {
          schedulePendingEscape();
          return;
        }
        if (pendingInput.subarray(0, LEFT_ARROW.length).equals(LEFT_ARROW)) {
          pendingInput = Buffer.alloc(0);
          finish(0, true);
          return;
        }

        // Everything else belongs to the provider: Esc, Alt+<control byte> such as Option+Enter,
        // Alt+<printable key>, and complete CSI/SS3 sequences are all forwarded verbatim.
        const escapeLength = completeEscapeSequenceLength(pendingInput);
        if (escapeLength === undefined) {
          schedulePendingEscape();
          return;
        }
        const sequence = pendingInput.subarray(0, escapeLength);
        sendInput(sequence);
        pendingInput = pendingInput.subarray(escapeLength);
        if (sequence.equals(PASTE_START)) {
          insidePaste = true;
          pasteEndMatched = 0;
        }
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

/**
 * Locate the end of a bracketed paste without ever holding a byte back.
 *
 * The terminator can be split across reads, so the count of bytes matched so far is carried between
 * calls. Every byte is forwarded the moment it arrives; only the bookkeeping crosses a read boundary.
 */
function pasteTerminatorEnd(
  input: Buffer,
  matchedSoFar: number,
): { matched: number; endIndex: number | undefined } {
  let matched = matchedSoFar;
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index]!;
    if (byte === PASTE_END[matched]) matched += 1;
    else matched = byte === PASTE_END[0] ? 1 : 0;
    if (matched === PASTE_END.length) return { matched: 0, endIndex: index + 1 };
  }
  return { matched, endIndex: undefined };
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
