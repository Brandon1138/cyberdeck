import { join } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface NativeTurn {
  id: string;
  occurredAt: string;
  text: string;
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
        };
      };
      const payload = frame.payload;
      if (
        frame.type === "session_meta"
        && payload?.originator === "codex-tui"
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
      || typeof payload.last_agent_message !== "string"
      || payload.last_agent_message.trim() === ""
    ) return undefined;
    return {
      id: payload.turn_id,
      occurredAt: typeof frame.timestamp === "string"
        ? frame.timestamp
        : now?.() ?? new Date().toISOString(),
      text: payload.last_agent_message,
    };
  } catch {
    return undefined;
  }
}

/**
 * Claude's final text is a candidate, not a completion: Stop hooks can continue the turn.
 * Only turn_duration closes it. Keep early markers pending until their text arrives, draining
 * oldest first so a later marker cannot claim an earlier completion ordinal.
 */
export class ClaudeTurnStops {
  private readonly candidates = new Map<string, NativeTurn>();
  private readonly stops = new Map<string, string>();
  private closedThrough = "";

  reset(): void {
    this.candidates.clear();
    this.stops.clear();
    this.closedThrough = "";
  }

  observe(line: string, now: (() => string) | undefined): NativeTurn[] {
    try {
      const frame = JSON.parse(line) as {
        type?: unknown; subtype?: unknown; timestamp?: unknown; uuid?: unknown;
        isSidechain?: unknown;
      };
      if (frame.isSidechain === true) return [];
      const candidate = parseClaudeTurn(line, now);
      if (candidate !== undefined && candidate.occurredAt > this.closedThrough) {
        this.candidates.set(candidate.id, candidate);
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
      if (final === undefined) break;
      // Preserve the assistant id used by semanticTurnIds across broker versions/restarts.
      turns.push({ ...final, occurredAt: at });
      this.closedThrough = at;
      this.stops.delete(id);
      for (const candidate of candidates) this.candidates.delete(candidate.id);
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
