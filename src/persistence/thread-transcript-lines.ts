import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

export interface NativeTurn {
  id: string;
  occurredAt: string;
  text: string;
  /** Complete-frame boundary in this exactly bound native source; never a timestamp guess. */
  sourceOffset?: number;
  data?: Record<string, unknown>;
}


export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/gu, "-");
}

export function candidateDayDirectories(root: string, timestamp: number): string[] {
  const directories = new Set<string>();
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const date = new Date(timestamp + offset);
    directories.add(join(
      root,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ));
  }
  return [...directories];
}

export async function readCodexMetadata(
  path: string,
): Promise<{ id: string; timestamp: string; cwd: string } | undefined> {
  let metadata: { id: string; timestamp: string; cwd: string } | undefined;
  await visitLines(path, (line) => {
    try {
      const frame = JSON.parse(line) as {
        type?: unknown;
        payload?: {
          id?: unknown;
          timestamp?: unknown;
          cwd?: unknown;
          originator?: unknown;
          source?: unknown;
        };
      };
      const payload = frame.payload;
      if (
        frame.type === "session_meta"
        && payload?.originator === "codex-tui"
        && !(typeof payload.source === "object" && payload.source !== null && "subagent" in payload.source)
        && typeof payload.id === "string"
        && typeof payload.timestamp === "string"
        && typeof payload.cwd === "string"
      ) {
        metadata = { id: payload.id, timestamp: payload.timestamp, cwd: payload.cwd };
      }
    } catch {
      // Ignore incomplete or unrelated provider frames.
    }
    return false;
  });
  return metadata;
}

export interface CodexLaunchIdentity { id: string; text?: string | undefined; textHash?: string | undefined }

/** The same exact-text rule survives journal rotation without persisting the brief twice. */
export function codexLaunchFingerprint(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

/** Only the launch turn can identify a rollout; later prompts and assistant text cannot. */
export async function codexLaunchMatches(path: string, identity: CodexLaunchIdentity): Promise<boolean> {
  const matches = (value: unknown): boolean => {
    if (typeof value === "string") return value.trim() === identity.text?.trim()
      || identity.textHash !== undefined && codexLaunchFingerprint(value) === identity.textHash
      || value.split(/[^a-zA-Z0-9-]+/u).includes(identity.id);
    if (Array.isArray(value)) return value.some(matches);
    return typeof value === "object" && value !== null && Object.values(value).some(matches);
  };
  let matched = false, sawContext = false;
  await visitLines(path, (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return true; }
    if (frame.type === "turn_context" && !sawContext) {
      sawContext = true;
      // Context instructions can carry the broker's launch marker, never a model/assistant echo.
      matched = matches(frame.payload?.developer_instructions) || matches(frame.payload?.user_instructions);
      if (matched) return false;
    }
    if (frame.type === "event_msg" && frame.payload?.type === "user_message") {
      matched = matches(frame.payload.message);
      return false;
    }
    // A completion without an identifying launch prompt is unavailable, not canonical evidence.
    return !(frame.type === "event_msg" && frame.payload?.type === "task_complete");
  });
  return matched;
}

export function parseClaudeTurn(line: string, now: (() => string) | undefined): NativeTurn | undefined {
  try {
    const frame = JSON.parse(line) as {
      type?: unknown;
      timestamp?: unknown;
      uuid?: unknown;
      message?: {
        id?: unknown;
        role?: unknown;
        stop_reason?: unknown;
        content?: unknown;
      };
    };
    const message = frame.message;
    if (
      frame.type !== "assistant"
      || message?.role !== "assistant"
      || message.stop_reason !== "end_turn"
      || !Array.isArray(message.content)
    ) return undefined;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } =>
        typeof block === "object"
        && block !== null
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
      )
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    const id = typeof message.id === "string"
      ? message.id
      : typeof frame.uuid === "string"
        ? frame.uuid
        : undefined;
    if (id === undefined || text === "") return undefined;
    return {
      id,
      occurredAt: typeof frame.timestamp === "string"
        ? frame.timestamp
        : now?.() ?? new Date().toISOString(),
      text,
    };
  } catch {
    return undefined;
  }
}

export function parseCodexTurn(line: string, now: (() => string) | undefined): NativeTurn | undefined {
  try {
    const frame = JSON.parse(line) as {
      type?: unknown;
      timestamp?: unknown;
      payload?: {
        type?: unknown;
        turn_id?: unknown;
        last_agent_message?: unknown;
      };
    };
    const payload = frame.payload;
    if (
      frame.type !== "event_msg"
      || payload?.type !== "task_complete"
      || typeof payload.turn_id !== "string"
      || payload.turn_id.length === 0
      || (payload.last_agent_message !== undefined && payload.last_agent_message !== null
        && typeof payload.last_agent_message !== "string")
    ) return undefined;
    return {
      id: payload.turn_id,
      occurredAt: typeof frame.timestamp === "string"
        ? frame.timestamp
        : now?.() ?? new Date().toISOString(),
      text: typeof payload.last_agent_message === "string" ? payload.last_agent_message : "",
      data: { nativeTimestampKnown: typeof frame.timestamp === "string" && Number.isFinite(Date.parse(frame.timestamp)) },
    };
  } catch {
    return undefined;
  }
}

export interface NativeActivityEvidence {
  id: string;
  occurredAt?: string;
  kind: string;
  providerTurnId?: string;
}

/** Read activity from causal native lifecycle frames, never from output wording. */
export function parseNativeActivity(
  provider: string, line: string, offset: number, completed: NativeTurn[],
): { state: "working" | "idle"; evidence: NativeActivityEvidence } | undefined {
  try {
    const frame = JSON.parse(line) as { type?: unknown; subtype?: unknown; timestamp?: unknown;
      uuid?: unknown; isSidechain?: unknown; isMeta?: unknown;
      payload?: { type?: unknown; turn_id?: unknown }; message?: { role?: unknown } };
    if (frame.isSidechain === true || frame.isMeta === true) return undefined;
    const turnId = typeof frame.payload?.turn_id === "string" ? frame.payload.turn_id : undefined;
    let state: "working" | "idle", kind: string;
    if (provider === "codex" && frame.type === "event_msg" && frame.payload?.type === "task_started") {
      state = "working"; kind = "task_started";
    } else if (provider === "codex" && frame.type === "event_msg" && frame.payload?.type === "turn_aborted") {
      state = "idle"; kind = "turn_aborted";
    } else if (provider === "codex" && completed.length > 0) {
      state = "idle"; kind = "task_complete";
    } else if (provider === "claude" && completed.length > 0) {
      const last = completed.at(-1)!;
      return { state: "idle", evidence: { id: last.id, ...(typeof frame.timestamp === "string" ? { occurredAt: frame.timestamp } : {}), kind: "turn_duration" } };
    } else if (provider === "claude" && ((frame.type === "user" && frame.message?.role === "user")
      || (frame.type === "assistant" && frame.message?.role === "assistant"))) {
      state = "working"; kind = frame.type;
    } else return undefined;
    return { state, evidence: {
      id: typeof frame.uuid === "string" ? frame.uuid : `${kind}:${turnId ?? offset}`,
      kind, ...(typeof frame.timestamp === "string" ? { occurredAt: frame.timestamp } : {}),
      ...(turnId === undefined ? {} : { providerTurnId: turnId }),
    } };
  } catch { return undefined; }
}

/** Every abort is a source-history negative receipt, even if later activity hides it. */
export function parseCodexAbort(line: string, offset: number, now?: () => string): NativeTurn | undefined {
  const activity = parseNativeActivity("codex", line, offset, []);
  if (activity?.evidence.kind !== "turn_aborted") return undefined;
  const evidence = activity.evidence;
  const known = evidence.occurredAt !== undefined && Number.isFinite(Date.parse(evidence.occurredAt));
  return { id: evidence.providerTurnId ?? `aborted:${evidence.id}`,
    occurredAt: known ? evidence.occurredAt! : now?.() ?? new Date().toISOString(),
    text: "Provider turn was cancelled", data: { outcome: "cancelled", nativeActivityId: evidence.id, nativeTimestampKnown: known } };
}

/**
 * Claude's final text is a candidate, not a completion: Stop hooks can continue the turn.
 * Only turn_duration closes it. Keep early markers pending until their assistant frame arrives, draining
 * oldest first so a later marker cannot claim an earlier completion ordinal.
 */
export class ClaudeTurnStops {
  private readonly candidates = new Map<string, NativeTurn>();
  private readonly textlessAssistantTimes = new Set<string>();
  private readonly stops = new Map<string, string>();
  private closedThrough = "";

  reset(): void {
    this.candidates.clear();
    this.textlessAssistantTimes.clear();
    this.stops.clear();
    this.closedThrough = "";
  }

  observe(line: string, now: (() => string) | undefined): NativeTurn[] {
    try {
      const frame = JSON.parse(line) as {
        type?: unknown; subtype?: unknown; timestamp?: unknown; uuid?: unknown;
        isSidechain?: unknown;
        message?: { role?: unknown; content?: unknown };
      };
      if (frame.isSidechain === true) return [];
      const candidate = parseClaudeTurn(line, now);
      if (candidate !== undefined && candidate.occurredAt > this.closedThrough) {
        this.candidates.set(candidate.id, candidate);
      } else if (frame.type === "assistant" && frame.message?.role === "assistant"
        && Array.isArray(frame.message.content) && typeof frame.timestamp === "string"
        && frame.timestamp > this.closedThrough) {
        this.textlessAssistantTimes.add(frame.timestamp);
      }
      if (frame.type === "system" && frame.subtype === "turn_duration"
        && typeof frame.timestamp === "string" && frame.timestamp > this.closedThrough) {
        this.stops.set(typeof frame.uuid === "string" ? frame.uuid : frame.timestamp, frame.timestamp);
      }
    } catch {
      return [];
    }
    const turns: NativeTurn[] = [];
    for (const [id, at] of [...this.stops].sort((left, right) => left[1].localeCompare(right[1]))) {
      if (at <= this.closedThrough) { this.stops.delete(id); continue; }
      const candidates = [...this.candidates.values()]
        .filter((turn) => turn.occurredAt > this.closedThrough && turn.occurredAt <= at)
        .sort(compareNativeTurns);
      const final = candidates.at(-1);
      const textlessTimes = [...this.textlessAssistantTimes].filter((time) => time > this.closedThrough && time <= at);
      if (final === undefined && textlessTimes.length === 0) break;
      // Preserve the assistant id used by semanticTurnIds across broker versions/restarts.
      // A completed tool-only/empty response still owns an ordinal, with a stable stop-derived id.
      turns.push(final === undefined ? { id: `stop:${id}`, occurredAt: at, text: "" } : { ...final, occurredAt: at });
      this.closedThrough = at;
      this.stops.delete(id);
      for (const candidate of candidates) this.candidates.delete(candidate.id);
      for (const time of textlessTimes) this.textlessAssistantTimes.delete(time);
    }
    return turns;
  }
}

export function compareNativeTurns(left: NativeTurn, right: NativeTurn): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

export async function visitLines(
  path: string,
  visitor: (line: string) => boolean,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() !== "" && !visitor(line)) break;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== "ENOENT") throw error;
}

/**
 * The complete newline-terminated lines appended after `offset`, and the offset just past the last
 * one. A trailing line with no terminating `\n` yet — the writer mid-append — is left unread and
 * `nextOffset` stops before it, so the next call picks it back up whole rather than parsing a
 * half-written frame.
 */
export async function readCompleteLinesFromOffset(
  path: string,
  offset: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { start: offset });
    stream.on("data", (chunk) => chunks.push(chunk as Buffer));
    stream.on("end", resolve);
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  if (chunks.length === 0) return { lines: [], nextOffset: offset };
  const buffer = Buffer.concat(chunks);
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], nextOffset: offset };
  const lines = buffer
    .subarray(0, lastNewline + 1)
    .toString("utf8")
    .split("\n")
    .slice(0, -1)
    .map((line) => line.replace(/\r$/u, ""));
  return { lines, nextOffset: offset + lastNewline + 1 };
}
