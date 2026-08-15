import { ReasoningEffortSchema, type ReasoningEffort } from "../domain/session.js";

/**
 * The model a session is actually running, as its own provider recorded it.
 *
 * This is an observation, never a request. A session started on Sonnet and switched to Opus inside
 * the provider's own CLI reports Opus here from the first turn Opus produces, which is the only
 * moment the change becomes a fact on disk rather than a keystroke in someone's pane.
 */
export interface ObservedModel {
  model: string;
  /** The provider's reasoning effort, when it records one alongside the model. */
  effort?: ReasoningEffort;
  /** The transcript frame's own timestamp, when it carried one. */
  observedAt?: string;
}

/**
 * A Claude assistant frame names the model that produced it, and — since 2.1 — the effort it ran at.
 *
 * Only assistant frames are read: a user frame carries no model, and a sidechain frame is a subagent
 * that may be running something else entirely, which is not what the session's own column reports.
 */
export function parseClaudeModelLine(line: string): ObservedModel | undefined {
  const frame = parseFrame(line);
  if (frame === undefined || frame.type !== "assistant") return undefined;
  if (frame.isSidechain === true || frame.isMeta === true) return undefined;
  const message = asRecord(frame.message);
  const model = message?.model;
  if (typeof model !== "string" || model.trim() === "") return undefined;
  return {
    model: model.trim(),
    ...effortOf(frame.effort),
    ...(typeof frame.timestamp === "string" ? { observedAt: frame.timestamp } : {}),
  };
}

/**
 * A Codex `turn_context` frame states the model and effort the next turn will run with.
 *
 * Codex writes one per turn, so a `/model` change mid-session appears as a new frame rather than as
 * an edit to an old one, and the last frame in the file is the session's present tense.
 */
export function parseCodexModelLine(line: string): ObservedModel | undefined {
  const frame = parseFrame(line);
  if (frame === undefined || frame.type !== "turn_context") return undefined;
  const payload = asRecord(frame.payload);
  const model = payload?.model;
  if (typeof model !== "string" || model.trim() === "") return undefined;
  return {
    model: model.trim(),
    ...effortOf(payload?.effort),
    ...(typeof frame.timestamp === "string" ? { observedAt: frame.timestamp } : {}),
  };
}

/**
 * How to read a running model out of a provider's own transcript, or nothing when it keeps none.
 *
 * Cursor and Antigravity write no native transcript, so there is no frame that could say what they
 * switched to. They are absent here on purpose: the callers render the launch value marked as a
 * launch value rather than assert it is still current.
 */
export function observedModelParser(
  provider: string,
): ((line: string) => ObservedModel | undefined) | undefined {
  if (provider === "claude") return parseClaudeModelLine;
  if (provider === "codex") return parseCodexModelLine;
  return undefined;
}

function effortOf(value: unknown): { effort: ReasoningEffort } | Record<string, never> {
  const parsed = ReasoningEffortSchema.safeParse(value);
  return parsed.success ? { effort: parsed.data } : {};
}

function parseFrame(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
