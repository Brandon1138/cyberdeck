import { plainTerminalText } from "./terminal-replay.js";
/**
 * Conversation preview extraction.
 *
 * The fleet preview must read like the beginning of the agent's latest reply. The provider TUIs
 * interleave that reply with spinner frames, token counters, tool summaries, startup banners and
 * approval prompts, and a PTY scrape of those frames also drops characters mid-word. So the
 * preferred source is the provider's own transcript (Claude JSONL / Codex rollout), where roles and
 * block types are structural; the terminal scrape is a last resort and gets the same noise
 * classifier applied to it.
 */
export type PreviewKind = "assistant" | "prompt" | "none";
export type PreviewSource = "transcript" | "record" | "terminal" | "prompt" | "none";
export type TranscriptRole = "assistant" | "user";
export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
  occurredAt?: string | undefined;
}
export interface ConversationPreview {
  /** Prose ready to render, already truncated at a word boundary. */
  text: string;
  /** `prompt` means no assistant reply exists yet and the caller must not present it as one. */
  kind: PreviewKind;
  source: PreviewSource;
}
export interface ConversationPreviewInput {
  /** Provider-native messages, oldest first. The preferred source. */
  transcript?: readonly TranscriptMessage[] | undefined;
  /** A preview already extracted upstream. Re-classified because older records hold TUI chrome. */
  storedPreview?: string | undefined;
  /** Raw PTY replay. Fallback only. */
  replay?: string | undefined;
  /** Task prompt to show when no assistant reply exists yet. */
  prompt?: string | undefined;
  maxLength?: number | undefined;
}
export const NO_PREVIEW_TEXT = "No response yet";
/** What the broker persists on the record; the fleet re-truncates to its column width. */
export const PREVIEW_STORAGE_LIMIT = 600;
/** How many trailing transcript messages a preview read keeps in memory. */
export const PREVIEW_MESSAGE_WINDOW = 40;
export function conversationPreview(input: ConversationPreviewInput): ConversationPreview {
  const maxLength = input.maxLength ?? PREVIEW_STORAGE_LIMIT;
  const fromTranscript = latestAssistantProse(input.transcript ?? []);
  if (fromTranscript !== "") {
    return { text: truncatePreview(fromTranscript, maxLength), kind: "assistant", source: "transcript" };
  }
  const fromRecord = input.storedPreview === undefined ? "" : extractProse(input.storedPreview, false);
  if (fromRecord !== "") {
    return { text: truncatePreview(fromRecord, maxLength), kind: "assistant", source: "record" };
  }
  const fromTerminal = input.replay === undefined ? "" : terminalProse(input.replay);
  if (fromTerminal !== "") {
    return { text: truncatePreview(fromTerminal, maxLength), kind: "assistant", source: "terminal" };
  }
  const prompt = firstNonEmpty(
    input.prompt === undefined ? "" : extractProse(input.prompt, false),
    latestUserProse(input.transcript ?? []),
    input.replay === undefined ? "" : terminalPrompt(input.replay),
  );
  if (prompt !== "") return { text: truncatePreview(prompt, maxLength), kind: "prompt", source: "prompt" };
  return { text: NO_PREVIEW_TEXT, kind: "none", source: "none" };
}
/**
 * Walk backward to the last assistant message that still carries prose after classification.
 * A message whose entire body is noise falls through to the previous one rather than to garbage.
 */
export function latestAssistantProse(messages: readonly TranscriptMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant") continue;
    const prose = extractProse(message.text, false);
    if (prose !== "") return prose;
  }
  return "";
}
export function latestUserProse(messages: readonly TranscriptMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "user") continue;
    const prose = extractProse(message.text, false);
    if (prose !== "") return prose;
  }
  return "";
}
/**
 * Terminal fallback. Everything up to and including the last echoed user prompt is discarded so the
 * preview describes the latest reply, then the same block classifier runs over what remains.
 */
export function terminalProse(replay: string): string {
  const lines = plainTerminalText(replay).split("\n");
  let start = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lineNoiseReason(normalizeLine(lines[index] ?? ""), true) === "prompt-echo") {
      start = index + 1;
      break;
    }
  }
  return extractProse(lines.slice(start).join("\n"), true);
}
export function terminalPrompt(replay: string): string {
  const lines = plainTerminalText(replay).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = normalizeLine(lines[index] ?? "");
    if (lineNoiseReason(line, true) !== "prompt-echo") continue;
    const prompt = stripMarkdown(line.replace(PROMPT_MARKER, ""));
    if (prompt !== "") return prompt;
  }
  return "";
}
/**
 * Classify, drop noise blocks, strip markdown, and join what survives into one prose line taken from
 * the start of the text.
 */
export function extractProse(text: string, terminal: boolean): string {
  const classified = classifyLines(text.split("\n"), terminal);
  const dropped = dropNoiseBlocks(classified.map((line) => line.class));
  const kept = classified
    .filter((line, index) => dropped[index] !== true && line.class !== "blank")
    .map((line) => line.text);
  return joinProse(dropLeadingContinuation(kept));
}
/** Truncate at the last word boundary that keeps at least half the budget, then add an ellipsis. */
export function truncatePreview(text: string, maxLength: number): string {
  const characters = [...text];
  if (characters.length <= maxLength) return text;
  if (maxLength <= 1) return characters.slice(0, Math.max(0, maxLength)).join("");
  const limit = maxLength - 1;
  const head = characters.slice(0, limit).join("");
  const boundary = head.lastIndexOf(" ");
  const sliced = boundary >= Math.floor(limit / 2) ? head.slice(0, boundary) : head;
  return `${sliced.replace(/[\s,;:·–—-]+$/u, "").replace(/(?:…|\.\.\.)$/u, "")}…`;
}
// ---------------------------------------------------------------------------
// Provider transcript parsing
// ---------------------------------------------------------------------------
export function parseClaudeTranscript(jsonl: string): TranscriptMessage[] {
  return parseTranscript(jsonl, parseClaudeTranscriptLine);
}
export function parseCodexRollout(jsonl: string): TranscriptMessage[] {
  return parseTranscript(jsonl, parseCodexRolloutLine);
}
/**
 * One Claude JSONL frame. Only `assistant`/`user` frames carrying text blocks qualify: `tool_use`,
 * `tool_result`, `thinking` and every sidecar frame type (`system`, `progress`, `attachment`,
 * `last-prompt`, `file-history-snapshot`, …) describe machinery rather than conversation.
 */
export function parseClaudeTranscriptLine(line: string): TranscriptMessage | undefined {
  const frame = parseFrame(line);
  if (frame === undefined) return undefined;
  if (frame.isMeta === true || frame.isSidechain === true) return undefined;
  if (frame.type !== "assistant" && frame.type !== "user") return undefined;
  const message = asRecord(frame.message);
  const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : undefined;
  if (message === undefined || role === undefined) return undefined;
  const text = claudeContentText(message.content);
  if (text === "" || (role === "user" && isInjectedUserFrame(text))) return undefined;
  return {
    role,
    text,
    ...(typeof frame.timestamp === "string" ? { occurredAt: frame.timestamp } : {}),
  };
}
/**
 * One Codex rollout frame. `event_msg` carries the finished agent message, `response_item` carries
 * the same text as structured content; reasoning, function calls and token counts are machinery.
 */
export function parseCodexRolloutLine(line: string): TranscriptMessage | undefined {
  const frame = parseFrame(line);
  if (frame === undefined) return undefined;
  const payload = asRecord(frame.payload);
  if (payload === undefined) return undefined;
  const occurredAt = typeof frame.timestamp === "string" ? { occurredAt: frame.timestamp } : {};
  if (frame.type === "event_msg") {
    const text = payload.type === "task_complete"
      ? payload.last_agent_message
      : payload.type === "agent_message" || payload.type === "user_message"
        ? payload.message
        : undefined;
    if (typeof text !== "string" || text.trim() === "") return undefined;
    const role: TranscriptRole = payload.type === "user_message" ? "user" : "assistant";
    if (role === "user" && isInjectedUserFrame(text)) return undefined;
    return { role, text: text.trim(), ...occurredAt };
  }
  if (frame.type !== "response_item" || payload.type !== "message") return undefined;
  // `developer` messages are Codex's own instruction envelope, not conversation.
  const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : undefined;
  if (role === undefined) return undefined;
  const text = codexContentText(payload.content);
  if (text === "" || (role === "user" && isInjectedUserFrame(text))) return undefined;
  return { role, text, ...occurredAt };
}
function parseTranscript(
  jsonl: string,
  parse: (line: string) => TranscriptMessage | undefined,
): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of jsonl.split("\n")) {
    const message = parse(line);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}
function parseFrame(line: string): Record<string, unknown> | undefined {
  if (line.trim() === "") return undefined;
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}
function claudeContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text !== "")
    .join("\n\n")
    .trim();
}
function codexContentText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      return (record?.type === "output_text" || record?.type === "input_text")
        && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter((text) => text !== "")
    .join("\n\n")
    .trim();
}
/**
 * Both CLIs inject synthetic user turns — Claude's `<command-name>`/`<local-command-stdout>` and
 * Codex's `<environment_context>`/`<user_instructions>` envelopes. They are not what the operator
 * asked for, so they must never surface as the task prompt.
 */
function isInjectedUserFrame(text: string): boolean {
  return /^<(?:command-|local-command|bash-|system-reminder|environment_context|user_instructions)/u
    .test(text.trimStart());
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------
type LineClass = "blank" | "noise" | "fragment" | "prose";
interface ClassifiedLine {
  text: string;
  class: LineClass;
  reason?: string;
}
const PROMPT_MARKER = /^(?:›|❯|»|>)\s*/u;
const STATUS_GLYPHS = /^[*✳✢✻✽✶✷✧✦✱✲✴✵❋✺✹✸●○◐◑◒◓·•⠀-⣿]+\s*/u;
const LEADING_DECORATION = /^[\s─━═╌╍┄┅┈┉│┃╭╮╰╯┌┐└┘├┤┬┴┼▀▄█▌▐░▒▓⏺]+/u;
const TRAILING_DECORATION = /[\s─━═╌╍┄┅┈┉│┃╭╮╰╯┌┐└┘├┤┬┴┼▀▄█▌▐░▒▓]+$/u;
/**
 * Ordered noise rules. Each entry names the class of garbage it recognises so a regression can be
 * traced to the rule that stopped matching rather than to "the preview looks wrong".
 */
const NOISE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // Spinner frames. The verb is arbitrary and PTY scraping mangles it, so match the shape:
  // a status glyph, a (possibly truncated) word, an ellipsis.
  ["spinner", /^[*✳✢✻✽✶✷✧✦✱✲✴✵❋✺✹✸●○◐◑◒◓⠀-⣿]\s*[A-Za-z]*\s*…/u],
  ["spinner", /^[A-Za-z]{3,}…$/u],
  ["spinner", /^(?:[*✳✢✻✽✶✷✧✦●○⠀-⣿]\s*)?[A-Za-z]+(?:ing|ed)\s+for\s+\d+\s*[hms]/iu],
  // Counters are checked before the status verbs they usually share a line with, so a token line
  // reports as `tokens` rather than as whatever status phrase happened to trail it.
  ["tokens", /[↑↓⇡⇣]\s*[\d.,]+\s*[kKmM]?\s*tokens?\b/u],
  ["tokens", /^[\d.,]+\s*[kKmM]?\s+tokens?\b/iu],
  ["tokens", /\b\d+%\s+context\s+left\b/iu],
  ["tokens", /\bcontext left until auto-compact\b/iu],
  ["tokens", /\btotal (?:cost|duration|tokens)\b/iu],
  ["status", /\(\s*[\d.]+\s*[hms](?:\s+[\d.]+\s*[hms])*\s*(?:·|\))/u],
  ["status", /\bthinking with (?:low|medium|high|xhigh|max|ultra) effort\b/iu],
  ["status", /\b(?:esc to interrupt|ctrl\+c to stop|ctrl\+g to edit|shift\+tab to cycle|tab to queue message|ctrl\+t to (?:show|hide)|ctrl\+r to (?:expand|retry))\b/iu],
  ["status", /^(?:Working|Thinking|Loading|Composing|Waiting)(?:…|\.\.\.)?$/iu],
  ["status", /^[\d.]+\s*[hms](?:\s+[\d.]+\s*[hms])*$/u],
  ["banner", /\b\d+\s+MCP servers?\s+(?:need|needs|require|requires)\s+authentication\b/iu],
  ["banner", /^[▲△⚠✖✗]\s*\S/u],
  ["banner", /\brun \/mcp\b/iu],
  ["banner", /^(?:CYBERDECK|Claude Code|OpenAI Codex|Codex CLI|Cursor Agent|Antigravity)\b/iu],
  ["banner", /^Tips?(?:\s+for getting|\s*:)/iu],
  ["banner", /^(?:What's new|Use \/\w|Try "|← for agents|Starting MCP|Welcome (?:to|back)\b)/iu],
  ["banner", /^Running .* hook\b/iu],
  ["banner", /^https?:\/\/\S+$/u],
  ["banner", /^(?:model|directory|workdir|account|session|sandbox|approval|reasoning effort|version|provider):\s+\S/iu],
  ["notice", /^[■◼▪▫◾]\s*\S/u],
  ["notice", /\bconversation interrupted\b/iu],
  ["notice", /\binterrupted by user\b/iu],
  ["notice", /\brequest (?:cancelled|canceled|interrupted)\b/iu],
  ["notice", /\btell the model what to do\b/iu],
  ["notice", /\bAPI Error\b/u],
  ["notice", /\bauto-compact\b/iu],
  ["notice", /\bno conversation found\b/iu],
  ["notice", /\b(?:usage|rate) limit (?:reached|approaching)\b/iu],
  ["permission", /\bdo you want to proceed\?/iu],
  ["permission", /\bwould you like to (?:run|apply)\b/iu],
  ["permission", /\bneeds? (?:your )?(?:permission|approval)\b/iu],
  ["permission", /\bdo you trust the contents of this (?:project|folder)\?/iu],
  // An approval menu entry, not a numbered list item in a reply: menu entries never end a sentence.
  ["permission", /^(?:❯|›|>)?\s*\d+\.\s+(?:Yes|No)\b[^.!?]*$/iu],
  ["permission", /\b(?:esc to cancel|tab to amend|workspace-trust)\b/iu],
  ["permission", /\byes,\s+(?:proceed|and don't ask again)\b/iu],
  ["chrome", /^(?:›\s*)?(?:Explain this codebase|Describe a task for a new session|Ask about this codebase)$/iu],
  ["chrome", /\b(?:Cursor is waiting for you|Add a follow-up|permission mode|plan mode on)\b/iu],
  ["chrome", /^Composing\b/iu],
  ["chrome", /\?\s+for shortcuts\b/iu],
  ["chrome", /^\d+%$/u],
  ["chrome", /^[\s·•…⋯]+$/u],
  ["chrome", /^[›❯»▸▹◦>]+$/u],
  ["chrome", /^(?:-{3,}|\*{3,}|_{3,})$/u],
  ["table-rule", /^\|?[\s:|-]*\|[\s:|-]*$/u],
];
function classifyLines(lines: readonly string[], terminal: boolean): ClassifiedLine[] {
  let fenced = false;
  return lines.map((raw) => {
    const text = normalizeLine(raw);
    if (/^(?:```|~~~)/u.test(text)) {
      fenced = !fenced;
      return { text, class: "noise", reason: "code-fence" } as const;
    }
    if (fenced) return { text, class: "noise", reason: "code-block" } as const;
    if (text === "") return { text, class: "blank" } as const;
    const reason = lineNoiseReason(text, terminal);
    if (reason !== undefined) return { text, class: "noise", reason } as const;
    // Four spaces of indent is an indented code block in markdown and a tool-output gutter in a
    // TUI pane. Either way the line continues something above it and cannot bound a block.
    const continuation = /^ {4,}/u.test(raw) || isFragment(text);
    return { text, class: continuation ? "fragment" : "prose" } as const;
  });
}
/**
 * Name the noise class a line belongs to, or `undefined` when the line is conversation.
 * `terminal` widens the prompt-echo marker to `>`, which is a blockquote in transcript text.
 */
export function lineNoiseReason(line: string, terminal: boolean): string | undefined {
  const content = undecorate(line);
  if (content === "") return "chrome";
  for (const [name, pattern] of NOISE_PATTERNS) {
    if (pattern.test(content)) return name;
  }
  const tool = toolSummaryReason(content);
  if (tool !== undefined) return tool;
  const promptMarker = terminal ? PROMPT_MARKER : /^(?:›|❯|»)\s*/u;
  if (promptMarker.test(content) && content.replace(promptMarker, "").trim() !== "") return "prompt-echo";
  return undefined;
}
/**
 * Collapsed tool summaries are terse verb-plus-count lines with no sentence punctuation, which
 * separates "Ran 1 shell command" from a reply that happens to say "Ran 3 tests and they pass."
 */
function toolSummaryReason(content: string): string | undefined {
  if (/^⎿/u.test(content)) return "tool-output";
  if (/^(?:Update|Create|Read|Write|Edit|Bash|Glob|Grep|Task|TodoWrite|WebFetch|WebSearch|Search|Fetch|List)\([^)]*\)/u.test(content)) {
    return "tool-call";
  }
  if (/^[+-]?\s*\d+\s+(?:additions?|removals?|lines?)\b/iu.test(content)) return "tool-diffstat";
  if (/^Updated (?:todo list|plan)\b/iu.test(content)) return "tool-summary";
  const words = content.split(/\s+/u).filter((word) => word !== "");
  const verb = /^(?:Ran|Running|Read|Reading|Wrote|Writing|Edited|Editing|Searched|Searching|Listed|Listing|Fetched|Fetching|Executed|Executing|Called|Calling|Applied|Applying)\b/iu;
  return words.length <= 6 && !/[.!?:]$/u.test(content) && verb.test(content) && /\d/u.test(content)
    ? "tool-summary"
    : undefined;
}
/**
 * A line too weak to anchor a block: a mid-sentence continuation, a scrape-corrupted line, or a
 * stub too short to be a sentence. Fragments never survive next to noise, but survive on their own.
 */
function isFragment(content: string): boolean {
  if (/^(?:…|\.\.\.)/u.test(content)) return true;
  if (isCorrupted(content)) return true;
  const bare = undecorate(content).replace(STATUS_GLYPHS, "");
  const words = bare.split(/\s+/u).filter((word) => word !== "");
  if (words.length >= 4) return false;
  if (/[.!?]$/u.test(bare)) return false;
  return bare.replace(/[^\p{L}\p{N}]/gu, "").length < 12;
}
/**
 * Pane scraping drops characters mid-word ("col apsibl", "yo r changes"), which leaves orphaned
 * single letters. That is a reliable marker that the line came from a damaged scrape rather than a
 * transcript, so the line loses its standing as a block boundary.
 */
function isCorrupted(content: string): boolean {
  if (content.length < 16) return false;
  const tokens = content.split(/\s+/u).filter((token) => /\p{L}/u.test(token));
  return tokens.some((token) => /^\p{L}$/u.test(token) && token !== "a" && token !== "A" && token !== "I");
}
/**
 * Grow every noise line into the contiguous block it belongs to.
 *
 * Spinner frames, counters and banners arrive as clusters interleaved with unrecognisable debris,
 * so dropping matched lines alone just promotes the next fragment into the preview. A noise line
 * therefore consumes its neighbours in both directions until it reaches a block boundary, and the
 * boundaries are exactly the two things that can only belong to real content: a blank line, and a
 * prose line (four or more words, uncorrupted, not a mid-sentence continuation).
 */
function dropNoiseBlocks(classes: readonly LineClass[]): boolean[] {
  const dropped = classes.map((value) => value === "noise");
  for (let index = 0; index < classes.length; index += 1) {
    if (classes[index] !== "noise") continue;
    for (let up = index - 1; up >= 0 && classes[up] === "fragment"; up -= 1) dropped[up] = true;
    for (let down = index + 1; down < classes.length && classes[down] === "fragment"; down += 1) {
      dropped[down] = true;
    }
  }
  return dropped;
}
/**
 * A preview must not open mid-sentence. Prefer the first line that starts a sentence; failing that,
 * recover a sentence start from inside the first line before giving up and using it as-is.
 */
function dropLeadingContinuation(lines: readonly string[]): string[] {
  const start = lines.findIndex(isSentenceStart);
  if (start > 0) return [...lines.slice(start)];
  if (start === 0 || lines.length === 0) return [...lines];
  const first = lines[0] ?? "";
  const recovered = /[.!?]\s+(\p{Lu}.*)$/su.exec(first);
  const head = recovered?.[1] ?? first.replace(/^(?:…|\.\.\.)\s*/u, "");
  return [head, ...lines.slice(1)];
}
function isSentenceStart(line: string): boolean {
  if (/^(?:…|\.\.\.)/u.test(line)) return false;
  const first = [...stripMarkdown(line)].find((character) => /\p{L}|\p{N}/u.test(character));
  return first !== undefined && (/\p{N}/u.test(first) || first === first.toUpperCase());
}
function joinProse(lines: readonly string[]): string {
  return lines
    .map((line) => stripMarkdown(undecorate(line)))
    .filter((line) => line !== "")
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}
/** Reduce markdown to the prose it renders as, so a preview never shows raw syntax. */
export function stripMarkdown(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/u, "")
    .replace(/^\s{0,3}>\s?/u, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/(?<![\p{L}\p{N}*])\*([^*\n]+)\*(?![\p{L}\p{N}*])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/gu, "")
    .replace(/\|/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
function undecorate(line: string): string {
  return line.replace(LEADING_DECORATION, "").replace(TRAILING_DECORATION, "").trim();
}
function normalizeLine(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim();
}
function firstNonEmpty(...values: readonly string[]): string {
  return values.find((value) => value !== "") ?? "";
}

