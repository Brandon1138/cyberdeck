/**
 * One OSC 11 round trip: what colour is the terminal actually painting behind us?
 *
 * The octopus leaves its ground unpainted so it sits on the operator's own background — which means
 * nothing in the environment says what that background *is*. `TERM` doesn't, `COLORFGBG` is folklore
 * most terminals never set, and tmux hides the outer terminal entirely. The only party that knows is
 * the terminal itself, and OSC 11 (`ESC ] 11 ; ? BEL`) is the question it answers: modern emulators
 * reply with their background as `rgb:RRRR/GGGG/BBBB`, and tmux forwards the query to the client it
 * is attached to.
 *
 * The answer arrives on stdin, interleaved with whatever the operator managed to type first, so the
 * query runs once at startup before the key decoder owns the stream: raw mode on, read until the
 * reply or a deadline, then put back every byte that was not the reply. Silence is a real answer —
 * an older terminal, a tmux that will not forward — and it means *unknown*, never a guess.
 */

export interface TerminalBackground {
  red: number;
  green: number;
  blue: number;
}

/**
 * Light versus dark, by perceived luma. The threshold splits near-white operator themes from
 * near-black ones; genuinely mid-grey backgrounds land on whichever side they read closer to.
 */
export function isLightBackground({ red, green, blue }: TerminalBackground): boolean {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 > 0.5;
}

interface BackgroundQueryInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
  /** Node's `Readable#unshift`: returns bytes that were read but were not the reply. */
  unshift?(chunk: Buffer): unknown;
}

interface BackgroundQueryOutput {
  isTTY?: boolean;
  write(chunk: string | Uint8Array): unknown;
}

const QUERY = "\u001b]11;?\u0007";

/**
 * The reply, in every dialect a terminal actually speaks: `rgb:` or urxvt's `rgba:`, one to four
 * hex digits per channel, closed by BEL or ST — whichever the terminal favours, not whichever the
 * query used.
 */
const REPLY =
  /\u001b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/[0-9a-fA-F]{1,4})?(?:\u0007|\u001b\\)/u;

/** A hex channel of any width, scaled so `ff` and `ffff` both mean full. */
function channel(hex: string): number {
  return Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
}

/**
 * Asks once and waits briefly. Resolves with the background, or `undefined` when the terminal never
 * answered — in which case nothing was learned and callers must change nothing.
 *
 * Restores raw mode to what it was and pauses the stream on the way out, so the caller inherits
 * stdin exactly as if this never ran; typed-ahead keys are unshifted back for the same reason.
 */
export function queryTerminalBackground(
  input: BackgroundQueryInput,
  output: BackgroundQueryOutput,
  timeoutMs = 300,
): Promise<TerminalBackground | undefined> {
  if (input.isTTY !== true || output.isTTY !== true || input.setRawMode === undefined) {
    return Promise.resolve(undefined);
  }
  const previousRawMode = input.isRaw === true;
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result: TerminalBackground | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      input.off("data", onData);
      input.pause?.();
      input.setRawMode?.(previousRawMode);
      const bytes = buffer.toString("latin1");
      const reply = REPLY.exec(bytes);
      const leftover = reply === null
        ? buffer
        : Buffer.from(bytes.slice(0, reply.index) + bytes.slice(reply.index + reply[0].length), "latin1");
      if (leftover.length > 0) input.unshift?.(leftover);
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const reply = REPLY.exec(buffer.toString("latin1"));
      if (reply !== null) {
        finish({ red: channel(reply[1]!), green: channel(reply[2]!), blue: channel(reply[3]!) });
      }
    };
    const deadline = setTimeout(() => finish(undefined), timeoutMs);
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume?.();
    output.write(QUERY);
  });
}
