const CLAUDE_CLEAR_COMMAND = "<command-name>/clear</command-name>";

/**
 * The `/clear` Claude writes as the last user frame of the conversation it is abandoning.
 *
 * Deliberately strict about *where* the marker sits. The same literal appears inside ordinary
 * conversation whenever a session greps its own transcripts or quotes this file, and those arrive
 * as tool-result user frames carrying `toolUseResult`. Only a frame whose entire content opens with
 * the command block is Claude's own record of the command. Accepts a raw JSONL line or a parsed
 * frame so byte-cursor readers do not parse twice.
 */
export function isClaudeClearFrame(line: string | unknown): boolean {
  let frame: { type?: unknown; toolUseResult?: unknown; message?: { role?: unknown; content?: unknown } };
  if (typeof line === "string") {
    if (!line.includes(CLAUDE_CLEAR_COMMAND)) return false;
    try { frame = JSON.parse(line) as typeof frame; } catch { return false; }
  } else if (typeof line === "object" && line !== null) {
    frame = line as typeof frame;
  } else {
    return false;
  }
  if (frame.type !== "user" || frame.toolUseResult !== undefined) return false;
  const content = frame.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map((block) =>
          typeof block === "object"
          && block !== null
          && typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : ""
        )
        .join("")
      : "";
  return text.trimStart().startsWith(CLAUDE_CLEAR_COMMAND);
}
