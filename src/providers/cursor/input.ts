import type { ProviderSessionTerminal } from "../provider.js";

const DEFAULT_PASTE_COMMIT_DELAY_MS = 1_000;

export interface CursorPastedInputOptions {
  commitDelayMs?: number;
}

/**
 * Cursor accepts programmatically injected text as a paste. The first Enter accepts that paste
 * into the composer; after the UI settles, a second Enter submits the resulting prompt.
 */
export async function submitCursorPastedInput(
  terminal: ProviderSessionTerminal,
  message: string,
  options: CursorPastedInputOptions = {},
): Promise<void> {
  terminal.write(Buffer.from(message));
  terminal.write(Buffer.from("\r"));
  await terminal.wait(options.commitDelayMs ?? DEFAULT_PASTE_COMMIT_DELAY_MS);
  terminal.write(Buffer.from("\r"));
}
