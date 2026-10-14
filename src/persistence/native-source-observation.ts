import type { NativeSourceStatus } from "../orchestration/session/worker-turn-ports.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCodexTurn } from "./thread-transcript-lines.js";

export class NativeSourceError extends Error {
  constructor(readonly status: Exclude<NativeSourceStatus, "available">, reason: string) { super(reason); }
}

/** Complete malformed frames are errors, rather than evidence that a native source is absent. */
export function validateNativeFrame(provider: string, line: string, nativeSessionId?: string, cwd?: string): void {
  let frame: { type?: string; payload?: { type?: string; id?: string; cwd?: string; originator?: string; source?: { subagent?: unknown } } };
  try { frame = JSON.parse(line); }
  catch { throw new NativeSourceError("source-error", "NATIVE_FRAME_INVALID"); }
  if (provider === "codex" && frame?.type === "session_meta" && (frame.payload?.id !== nativeSessionId
    || frame.payload?.cwd !== cwd || frame.payload?.originator !== "codex-tui" || frame.payload?.source?.subagent !== undefined)) {
    throw new NativeSourceError("conflict", "NATIVE_BINDING_CONFLICT");
  }
  if (provider === "codex" && frame?.type === "event_msg" && frame.payload?.type === "task_complete"
    && parseCodexTurn(line, undefined) === undefined) throw new NativeSourceError("source-error", "NATIVE_FINAL_INVALID");
}

/** A date-window miss proves no identity. Absence requires an empty/missing native source root. */
export async function hasNativeRollouts(root: string): Promise<boolean> {
  let visited = 0;
  const scan = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > 4) throw new NativeSourceError("source-error", "NATIVE_DISCOVERY_LIMIT");
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && depth === 0) return [];
      throw error;
    });
    for (const entry of entries) {
      if (++visited > 10_000) throw new NativeSourceError("source-error", "NATIVE_DISCOVERY_LIMIT");
      if (entry.isSymbolicLink()) return true;
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return true;
      if (entry.isDirectory() && await scan(join(directory, entry.name), depth + 1)) return true;
    }
    return false;
  };
  return scan(root, 0);
}

/** An unreadable, invalid, escaped or conflicting source is never evidence of absence. */
export function nativeSourceFailure(error: unknown): { status: Exclude<NativeSourceStatus, "available">; reason: string } {
  if (error instanceof NativeSourceError) return { status: error.status, reason: error.message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : "NATIVE_SOURCE_ERROR";
  // Only a call site that positively checked the expected source may declare it missing.
  if (code === "ELOOP" || message === "ACTIVITY_SOURCE_ESCAPE" || message === "NATIVE_BINDING_CONFLICT") {
    return { status: "conflict", reason: "NATIVE_BINDING_CONFLICT" };
  }
  if (message === "NATIVE_CONVERSATION_UNBOUND" || message === "NATIVE_CONVERSATION_CLEARED") {
    return { status: "unbound", reason: message };
  }
  return { status: "source-error", reason: code ?? (/^[A-Z_]+$/u.test(message) ? message : "NATIVE_SOURCE_ERROR") };
}
