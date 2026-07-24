import type { ProviderId } from "../domain/session.js";

const OSC_TITLE = /\u001b\]0;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu;
const OSC_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu;
const HORIZONTAL_CURSOR_SEQUENCE = /\u001b\[(?:\d+)?[CG]/gu;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const OTHER_ESCAPE = /\u001b(?:[()][0-9A-Z]|[@-_])/gu;
const BRAILLE_SPINNER = /^[\u2800-\u28ff]/u;

export type ProviderTerminalActivity = "working" | "awaiting-input" | "needs-input" | "unknown";

/**
 * Derive the same compact provider activity used by both the cockpit and semantic worker waits.
 * Last-occurrence comparisons matter because PTY replay contains old working and idle frames.
 */
export function providerTerminalActivity(provider: ProviderId, replay: string): ProviderTerminalActivity {
  const plain = stripTerminalControl(replay);
  const blockedAt = lastBlockedPromptIndex(provider, plain);

  if (provider === "cursor") {
    if (blockedAt >= 0) return "needs-input";
    const workingAt = Math.max(replay.lastIndexOf("Composing"), replay.lastIndexOf("ctrl+c to stop"));
    const waitingAt = Math.max(
      replay.lastIndexOf("Cursor is waiting for you"),
      replay.lastIndexOf("Add a follow-up"),
    );
    if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  }


  if (provider === "antigravity") {
    const workingAt = lastBrailleIndex(plain);
    const waitingAt = Math.max(
      plain.lastIndexOf("? for shortcuts"),
      plain.lastIndexOf("> Plan mode:"),
    );
    if (blockedAt > Math.max(workingAt, waitingAt)) return "needs-input";
    if (workingAt >= 0 || waitingAt >= 0) return waitingAt > workingAt ? "awaiting-input" : "working";
  }

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
  if (blockedAt > Math.max(workingAt, waitingAt)) return "needs-input";

  const title = lastTerminalTitle(replay);
  if (title !== undefined) return BRAILLE_SPINNER.test(title) ? "working" : "awaiting-input";

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
 * Best-effort interactive-TUI preview: the beginning of the latest assistant reply.
 * Provider-native structured transcripts are not available on every PTY path, so the durable
 * session catalog stores this normalized value at turn completion rather than re-scraping it in
 * every Fleet render.
 */
export function latestAssistantParagraphPreview(replay: string): string {
  const stripped = stripTerminalControl(replay.replace(HORIZONTAL_CURSOR_SEQUENCE, " "))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const lines = stripped.split("\n");
  let replyStart: number | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.replace(/\s+/g, " ").trim() ?? "";
    if (isUserPromptLine(line)) {
      replyStart = index + 1;
      break;
    }
  }
  if (replyStart !== undefined) {
    for (const raw of lines.slice(replyStart)) {
      const line = raw.replace(/\s+/g, " ").trim();
      if (line === "" || isTerminalChrome(line)) continue;
      return line;
    }
    return "No response yet";
  }

  const paragraphs: string[][] = [];
  let paragraph: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line === "") {
      if (paragraph.length > 0) paragraphs.push(paragraph);
      paragraph = [];
      continue;
    }
    if (!isTerminalChrome(line) && paragraph.at(-1) !== line) paragraph.push(line);
  }
  if (paragraph.length > 0) paragraphs.push(paragraph);
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

function lastBlockedPromptIndex(provider: ProviderId, replay: string): number {
  const tailStart = Math.max(0, replay.length - 8_000);
  const tail = replay.slice(tailStart);
  const common = lastRegexIndex(
    tail,
    /Do you trust the contents of this project\?|workspace-trust|needs authentication|permission prompt/giu,
  );
  const providerPrompt = provider === "codex"
    ? Math.max(
        lastRegexIndex(
          tail,
          /Would you like to (?:run the following command|apply the following changes)\?[\s\S]{0,2400}?Yes, proceed/giu,
        ),
        lastRegexIndex(tail, /Codex needs (?:your )?(?:approval|permission)[\s\S]{0,1600}?(?:Allow|Yes)/giu),
      )
    : provider === "claude"
      ? Math.max(
          lastRegexIndex(tail, /Claude needs your permission[\s\S]{0,2400}?(?:Do you want to proceed\?|Allow)/giu),
          lastRegexIndex(tail, /Do you want to proceed\?[\s\S]{0,1600}?(?:Yes|Esc to cancel)/giu),
        )
      : -1;
  const index = Math.max(common, providerPrompt);
  return index < 0 ? -1 : tailStart + index;
}

function lastRegexIndex(value: string, pattern: RegExp): number {
  let index = -1;
  for (const match of value.matchAll(pattern)) index = match.index;
  return index;
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
  const content = line
    .replace(/^[\s─━═╭╰│┌└┐┘▀▄]+/u, "")
    .replace(/[\s─━═╭╰│┌└┐┘▀▄]+$/u, "");
  return /^(CYBERDECK|Claude Code|OpenAI Codex|Tips for getting|Tip:\s*(?:Use|Try the Desktop app|Paste an image with Ctrl\+V)|What's new|Use \/skills|Try "|← for agents|Starting MCP|Running .* hook|No output yet)/i.test(content)
    || /^https:\/\/chatgpt\.com\/codex\?app-landing-page=true$/i.test(content)
    || /^(?:model|directory):\s+/i.test(content)
    || /^(?:tab to queue message|\d+% context left)$/i.test(content)
    || /^Working(?:…|\.\.\.)?$/i.test(content)
    || /esc to interrupt|ctrl\+g to edit|ctrl\+c to stop|permission mode|plan mode on|shift\+tab to cycle|Add a follow-up|Composing(?: \d+ tokens)?$/i.test(content)
    || /^(?:›\s*)?(?:Explain this codebase|Describe a task for a new session|Ask about this codebase)$/i.test(content)
    || /Cursor is waiting for you|Composer \d|Gemini .* · (?:low|medium|high)$/i.test(content)
    || /^(?:Worked|Cogitated|Reasoned) for \d/i.test(content)
    || content === "";
}

function isUserPromptLine(line: string): boolean {
  return /^(?:›|❯|>)\s+\S/u.test(line)
    && !/^>\s*Plan mode:/iu.test(line);
}
