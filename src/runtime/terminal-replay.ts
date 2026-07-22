import type { ProviderId } from "../domain/session.js";

const OSC_TITLE = /\u001b\]0;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu;
const OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;
const HORIZONTAL_CURSOR_SEQUENCE = /\u001b\[(?:\d+)?[CG]/gu;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const OTHER_ESCAPE = /\u001b(?:[()][0-9A-Z]|[@-_])/gu;
const BRAILLE_SPINNER = /^[\u2800-\u28ff]/u;

export type ProviderTerminalActivity = "working" | "awaiting-input" | "blocked" | "unknown";

/**
 * Derive the same compact provider activity used by both the cockpit and semantic worker waits.
 * Last-occurrence comparisons matter because PTY replay contains old working and idle frames.
 */
export function providerTerminalActivity(provider: ProviderId, replay: string): ProviderTerminalActivity {
  if (isBlockedPrompt(replay)) return "blocked";

  if (provider === "cursor") {
    const workingAt = Math.max(replay.lastIndexOf("Composing"), replay.lastIndexOf("ctrl+c to stop"));
    const waitingAt = Math.max(
      replay.lastIndexOf("Cursor is waiting for you"),
      replay.lastIndexOf("Add a follow-up"),
    );
    if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  }


  if (provider === "antigravity") {
    const workingAt = lastBrailleIndex(replay);
    const waitingAt = Math.max(
      replay.lastIndexOf("? for shortcuts"),
      replay.lastIndexOf("> Plan mode:"),
    );
    if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  }

  const title = lastTerminalTitle(replay);
  if (title !== undefined) return BRAILLE_SPINNER.test(title) ? "working" : "awaiting-input";

  const plain = stripTerminalControl(replay);
  const workingAt = Math.max(
    plain.lastIndexOf("esc to interrupt"),
    plain.lastIndexOf("Composing"),
    plain.lastIndexOf("Working"),
  );
  const waitingAt = Math.max(
    plain.lastIndexOf("Cursor is waiting for you"),
    plain.lastIndexOf("Add a follow-up"),
    plain.lastIndexOf("Write tests for"),
  );
  if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  return "unknown";
}

export function terminalLines(replay: string): string[] {
  const stripped = stripTerminalControl(replay.replace(HORIZONTAL_CURSOR_SEQUENCE, " "))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines: string[] = [];
  for (const raw of stripped.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "" || lines.at(-1) === line) continue;
    lines.push(line);
  }
  return lines;
}

export function stripTerminalControl(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(OTHER_ESCAPE, "")
    .replace(/[\u000f]/g, "");
}

export function latestTerminalPreview(replay: string): string {
  return latestAssistantParagraphPreview(replay);
}

/**
 * Best-effort interactive-TUI preview: the first rendered line of the last substantive paragraph.
 * Provider-native structured transcripts are not available on every PTY path, so the durable
 * session catalog stores this normalized value at turn completion rather than re-scraping it in
 * every Fleet render.
 */
export function latestAssistantParagraphPreview(replay: string): string {
  const stripped = stripTerminalControl(replay.replace(HORIZONTAL_CURSOR_SEQUENCE, " "))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const paragraphs: string[][] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) paragraphs.push(paragraph);
    paragraph = [];
  };
  for (const raw of stripped.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "") {
      flush();
      continue;
    }
    if (isTerminalChrome(line)) continue;
    if (paragraph.at(-1) !== line) paragraph.push(line);
  }
  flush();
  return paragraphs.at(-1)?.[0] ?? "No response yet";
}

/** Return only the useful tail of a terminal replay, never the full PTY transcript. */
export function compactTerminalResult(replay: string, maxChars = 1_200): string {
  const bounded = Math.max(200, Math.min(maxChars, 4_000));
  const meaningful = terminalLines(replay).filter((line) => !isTerminalChrome(line));
  const selected: string[] = [];
  let length = 0;
  for (let index = meaningful.length - 1; index >= 0; index -= 1) {
    const line = meaningful[index];
    if (line === undefined) continue;
    const added = line.length + (selected.length === 0 ? 0 : 1);
    if (length + added > bounded && selected.length > 0) break;
    selected.unshift(line);
    length += added;
  }
  const result = selected.join("\n");
  if (result.length <= bounded) return result || "No useful provider output yet";
  return result.slice(result.length - bounded);
}

function lastTerminalTitle(replay: string): string | undefined {
  let last: string | undefined;
  for (const match of replay.matchAll(OSC_TITLE)) last = match[1];
  return last;
}

function isBlockedPrompt(replay: string): boolean {
  const tail = stripTerminalControl(replay.slice(-8_000));
  return /Do you trust the contents of this project\?|workspace-trust|needs authentication|permission prompt/i.test(tail);
}

function lastBrailleIndex(value: string): number {
  let last = -1;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x2800 && code <= 0x28ff) {
      last = index;
      break;
    }
  }
  return last;
}

function isTerminalChrome(line: string): boolean {
  return /^(CYBERDECK|Claude Code|OpenAI Codex|Tips for getting|Tip: Use|What's new|Use \/skills|Try "|← for agents|Starting MCP|Running .* hook|No output yet)/i.test(line)
    || /^Working(?:…|\.\.\.)?$/i.test(line)
    || /esc to interrupt|ctrl\+g to edit|ctrl\+c to stop|permission mode|plan mode on|shift\+tab to cycle|Add a follow-up|Composing(?: \d+ tokens)?$/i.test(line)
    || /^(?:›\s*)?(?:Explain this codebase|Describe a task for a new session|Ask about this codebase)$/i.test(line)
    || /Cursor is waiting for you|Composer \d|Gemini .* · (?:low|medium|high)$/i.test(line)
    || /^(?:Worked|Cogitated|Reasoned) for \d/i.test(line)
    || /^[-─━═╭╰│┌└┐┘▀▄ ]+$/u.test(line);
}
