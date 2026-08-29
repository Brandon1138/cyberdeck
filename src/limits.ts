/** Shared interactive fleet limits. Keep runtime policy and MCP batch schemas in lockstep. */
export { DEFAULT_MAX_CONCURRENT_WORKERS } from "./domain/limits.js";
export const MAX_FANOUT_BATCH = 64;

/**
 * Deadline layers that can interrupt one logical worker wait, tightest first:
 *
 * 1. the MCP client abandons the in-flight `tools/call` — Claude Code backgrounds it at 120s,
 *    Codex kills it at 300s. Cyberdeck does not own either value and cannot extend them.
 * 2. `timeoutSeconds` accepted by the tool schema and the broker RPC schema (`MAX_WAIT_SECONDS`).
 * 3. the registry clamp applied to whatever milliseconds reach `waitForWorkerResults`.
 *
 * Layers 2 and 3 are ours and are pinned to the same constant so they cannot drift. Layer 1 is
 * reconciled by answering every transport segment within `MAX_WAIT_SEGMENT_SECONDS` and handing
 * back a resumable ticket, so a long logical wait is honored across several short calls instead of
 * being silently truncated by a deadline the caller cannot see.
 */
export const MAX_WAIT_SECONDS = 600;
export const DEFAULT_WAIT_SECONDS = 300;
/** Comfortably below the tightest observed client deadline (120s) with room for broker latency. */
export const MAX_WAIT_SEGMENT_SECONDS = 90;
/** Frozen idle worker threshold before waits return a diagnosable stalled state. */
export const DEFAULT_WORKER_STALL_SECONDS = 60;

/** Thread listing must stay answerable inside a caller's token budget at 64 concurrent workers. */
export const DEFAULT_THREAD_PAGE = 50;
export const MAX_THREAD_PAGE = 200;
export const THREAD_PREVIEW_CHARS = 200;
