import type { ProviderSessionTerminal } from "../provider.js";
import { ProviderPermissionModeNotAppliedError } from "../session-adapter-errors.js";
import { plainTerminalText } from "../../runtime/terminal-replay.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

export interface CursorRunEverythingOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export async function enableCursorRunEverything(
  terminal: ProviderSessionTerminal,
  options: CursorRunEverythingOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  await waitForTerminal(
    terminal,
    (replay) => cursorInputReady(replay),
    timeoutMs,
    pollIntervalMs,
    "Composer input did not become ready before /run-everything setup",
  );

  let touchedInput = false;
  try {
    const commandOffset = terminal.snapshot().length;
    terminal.write(Buffer.from("/run-everything\r"));
    touchedInput = true;
    const submission = await waitForTerminal(
      terminal,
      (replay) => {
        const commandReplay = replay.subarray(commandOffset);
        if (cursorInputReady(commandReplay)) return "committed" as const;
        const menuState = cursorRunEverythingState(commandReplay);
        if (menuState === "disabled") return "select" as const;
        if (menuState === "enabled") return "already-enabled" as const;
        return undefined;
      },
      timeoutMs,
      pollIntervalMs,
      "Composer did not return to input after committing /run-everything",
    );
    if (submission !== "committed") {
      terminal.write(Buffer.from(submission === "select" ? "\r" : "\u001b"));
      await waitForTerminal(
        terminal,
        (replay) => cursorInputReady(replay.subarray(commandOffset)),
        timeoutMs,
        pollIntervalMs,
        "Composer did not return to input after selecting /run-everything",
      );
    }

    const readbackOffset = terminal.snapshot().length;
    terminal.write(Buffer.from("/"));
    const mode = await waitForTerminal(
      terminal,
      (replay) => cursorRunEverythingState(replay.subarray(readbackOffset)),
      timeoutMs,
      pollIntervalMs,
      "Composer did not expose /run-everything state for verification",
    );
    if (mode !== "enabled") {
      throw new ProviderPermissionModeNotAppliedError(
        "Composer /run-everything setup failed: provider still reports manual mode",
      );
    }
  } finally {
    if (touchedInput) {
      // Close a readback menu or clear a partially entered command on every success/failure path.
      terminal.write(Buffer.from("\u001b"));
      await terminal.wait(pollIntervalMs);
    }
  }
}

export function cursorInputReady(replay: Uint8Array): boolean {
  const plain = plainTerminalText(Buffer.from(replay).toString("utf8"));
  return /Cursor is waiting for you|Add a follow-up/iu.test(plain)
    || /(?:^|\n)\s*[→›❯]\s+Plan,\s+search,\s+build\s+anything\s*(?:\n|$)/iu.test(plain)
    || /(?:^|\n)\s*[→›❯]\s*(?:\n|$)/u.test(plain);
}

export function cursorRunEverythingState(
  replay: Uint8Array,
): "enabled" | "disabled" | undefined {
  const plain = plainTerminalText(Buffer.from(replay).toString("utf8"));
  const matches = plain.matchAll(
    /\/run-everything[\s\S]{0,240}?currently\s+(enabled|disabled)/giu,
  );
  let state: "enabled" | "disabled" | undefined;
  for (const match of matches) state = match[1]?.toLowerCase() as typeof state;
  return state;
}

async function waitForTerminal<T>(
  terminal: ProviderSessionTerminal,
  inspect: (replay: Buffer) => T | undefined | false,
  timeoutMs: number,
  pollIntervalMs: number,
  timeoutMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = inspect(terminal.snapshot());
    if (value !== undefined && value !== false) return value;
    if (Date.now() >= deadline) {
      throw new ProviderPermissionModeNotAppliedError(timeoutMessage);
    }
    await terminal.wait(pollIntervalMs);
  }
}
