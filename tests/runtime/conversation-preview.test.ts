import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  conversationPreview,
  lineNoiseReason,
  parseClaudeTranscript,
  parseCodexRollout,
  stripMarkdown,
  terminalProse,
  truncatePreview,
  type TranscriptMessage,
} from "../../src/runtime/conversation-preview.js";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "preview");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function claude(name: string): TranscriptMessage[] {
  return parseClaudeTranscript(fixture(name));
}

function codex(name: string): TranscriptMessage[] {
  return parseCodexRollout(fixture(name));
}

/** Every garbage class the fleet preview was observed rendering in production. */
const GARBAGE_LINES: ReadonlyArray<readonly [string, string]> = [
  ["spinner", "* Levitating… (14m 25s · ↓ 47.3k tokens)"],
  ["spinner", "✳ Puttering…"],
  ["spinner", "ontificating…"],
  ["spinner", "* Cogitating for 11m 12s"],
  ["spinner", "─ Worked for 12m 25s ────────────────────────────"],
  ["status", "(2s · thinking with high effort)"],
  ["status", "✢ n f thinking with high effort"],
  ["status", "esc to interrupt"],
  ["tokens", "↓ 25 tokens · thinking with high effort)"],
  ["tokens", "12% context left"],
  ["tool-summary", "Ran 1 shell command"],
  ["tool-summary", "Running 1 shell command…"],
  ["tool-summary", "Read 4 files"],
  ["tool-call", "⏺ Bash(pnpm test)"],
  ["tool-output", "⎿  Test Files  38 passed (38)"],
  ["banner", "▲ 3 MCP servers need authentication · run /mcp"],
  ["banner", "Tip: Try the Desktop app. Run 'codex app' or visit"],
  ["banner", "https://chatgpt.com/codex?app-landing-page=true"],
  ["banner", "model: gpt-5.6-terra   high"],
  ["notice", "■ Conversation interrupted — tell the model what to do"],
  ["permission", "Do you want to proceed?"],
  ["permission", "❯ 1. Yes"],
  ["permission", "  2. Yes, and don't ask again for pnpm test commands"],
  ["permission", "Claude needs your permission to use Bash"],
  ["permission", "Do you trust the contents of this project?"],
  ["chrome", "? for shortcuts"],
  ["prompt-echo", "› Merge the two preview branches"],
];

describe("noise classification", () => {
  it.each(GARBAGE_LINES)("classifies %s: %s", (expected, line) => {
    expect(lineNoiseReason(line, true)).toBe(expected);
  });

  it("keeps conversation lines that merely resemble chrome", () => {
    const conversation = [
      "Ran 3 tests and they all pass.",
      "- Fix the auth middleware token expiry check",
      "* Levitating is the spinner verb the TUI happened to pick.",
      "1. Yes, this approach is the one I would take.",
      "The reply mentions 47.3k tokens of context but is still prose.",
    ];
    for (const line of conversation) expect(lineNoiseReason(line, true)).toBeUndefined();
  });
});

describe("block-level noise dropping", () => {
  it("drops the whole contiguous cluster rather than promoting the next junk line", () => {
    const replay = [
      "* Levitating… (14m 25s · ↓ 47.3k tokens)",
      "✢ g",
      "e n",
      "esc to interrupt",
      "The audit found two stale worktree leases and released both.",
    ].join("\n");
    expect(terminalProse(replay)).toBe(
      "The audit found two stale worktree leases and released both.",
    );
  });

  it("stops a noise block at a blank line instead of eating the reply below it", () => {
    const replay = [
      "Ran 1 shell command",
      "",
      "Short reply",
    ].join("\n");
    expect(terminalProse(replay)).toBe("Short reply");
  });

  it("recovers the reply from the captured worker-wait specimen", () => {
    const preview = conversationPreview({ replay: fixture("worker-wait-specimen.txt") });

    expect(preview).toEqual({
      kind: "assistant",
      source: "terminal",
      text: "I'll start by exploring the codebase to understand the current thread state",
    });
    expect(preview.text).not.toMatch(/Puttering|ontificating|tokens|WAVE 2|trunk|shell command/u);
  });

  it("excludes every observed garbage class from a full Claude pane scrape", () => {
    const preview = conversationPreview({ replay: fixture("claude-opus-pane.txt") });

    expect(preview.source).toBe("terminal");
    expect(preview.text).toBe(
      "The merge is clean and the preview column now reads from the transcript."
      + " Both branches touched different files, so nothing had to be resolved by hand.",
    );
    for (const [, line] of GARBAGE_LINES) {
      expect(preview.text).not.toContain(line.replace(/^[^\p{L}]+/u, "").slice(0, 12));
    }
  });

  it("excludes every observed garbage class from a full Codex pane scrape", () => {
    const preview = conversationPreview({ replay: fixture("codex-pane.txt") });

    expect(preview.source).toBe("terminal");
    expect(preview.text).toBe(
      "The grouping model stays untouched in this wave, so only the header row changes."
      + " Folder headers become focusable and collapsing one shows the count of threads it holds.",
    );
    expect(preview.text).not.toMatch(/Codex|Tip:|chatgpt\.com|interrupted|Cogitating|tokens/u);
  });
});

describe("Claude Opus transcript extraction", () => {
  it("skips tool_use, tool_result, thinking, sidechain and meta frames", () => {
    const messages = claude("claude-opus-transcript.jsonl");

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(messages.map((message) => message.text).join("\n")).not.toMatch(
      /"type":\s*"tool_use"|toolUseResult|stop hook|Subagent report|Plan mode is active|\/compact/u,
    );
  });

  it("previews the start of the last assistant reply as markdown-free prose", () => {
    const preview = conversationPreview({ transcript: claude("claude-opus-transcript.jsonl") });

    expect(preview).toEqual({
      kind: "assistant",
      source: "transcript",
      text: "Preview extraction now reads the transcript Conversation previews are sourced from the"
        + " provider's own JSONL, so tool_use and thinking blocks never reach the fleet row."
        + " See the classifier for the block rules. Pane scraping is now a fallback Noise is"
        + " dropped in contiguous blocks",
    });
  });

  it("falls back to the previous assistant reply when the latest one is all noise", () => {
    const preview = conversationPreview({ transcript: claude("claude-opus-noise-only-tail.jsonl") });

    expect(preview).toEqual({
      kind: "assistant",
      source: "transcript",
      text: "The reconciler now rehydrates finished threads, so the fleet header counters stay"
        + " consistent.",
    });
  });

  it("marks the task prompt as a prompt when no assistant text exists yet", () => {
    const preview = conversationPreview({ transcript: claude("claude-opus-prompt-only.jsonl") });

    expect(preview).toEqual({
      kind: "prompt",
      source: "prompt",
      text: "Add a per-thread PR indicator derived from the branch, cached and non-blocking.",
    });
  });
});

describe("Codex rollout extraction", () => {
  it("previews Codex Sol from agent_message and skips reasoning, calls and envelopes", () => {
    const messages = codex("codex-sol-rollout.jsonl");
    const preview = conversationPreview({ transcript: messages });

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ]);
    expect(messages.map((message) => message.text).join("\n")).not.toMatch(
      /environment_context|You are Codex|Locating the session store|function_call|exit_code/u,
    );
    expect(preview).toEqual({
      kind: "assistant",
      source: "transcript",
      text: "Thread records are stored in the session catalog now, so a broker restart rehydrates"
        + " finished threads as Done. The slot cap only counts running agents, which lets the"
        + " fleet accumulate history without manual cleanup.",
    });
  });

  it("falls back past a Codex Terra turn whose only output was a spinner and a notice", () => {
    const preview = conversationPreview({ transcript: codex("codex-terra-rollout.jsonl") });

    expect(preview).toEqual({
      kind: "assistant",
      source: "transcript",
      text: "The palette keeps color for actionable state only. Needs-input and done stay yellow;"
        + " stopped, idle and model metadata are greyscale.",
    });
  });

  it("renders Codex Luna markdown headings, code spans and tables as prose", () => {
    const preview = conversationPreview({ transcript: codex("codex-luna-rollout.jsonl") });

    expect(preview).toEqual({
      kind: "assistant",
      source: "transcript",
      text: "PR indicator The probe caches per branch and never blocks a render. When gh is absent,"
        + " unauthenticated, or the branch has no PR, the column renders nothing rather than an"
        + " error. state glyph open ● draft ○",
    });
    expect(preview.text).not.toMatch(/###|`|\|\s*---/u);
  });
});

describe("preview assembly", () => {
  it("prefers the transcript over a stored preview and a pane scrape", () => {
    const preview = conversationPreview({
      transcript: [{ role: "assistant", text: "Transcript wins." }],
      storedPreview: "Stored loses.",
      replay: "Replay loses.",
    });
    expect(preview).toEqual({ kind: "assistant", source: "transcript", text: "Transcript wins." });
  });

  it("re-classifies a stored preview so legacy chrome never repeats", () => {
    expect(conversationPreview({
      storedPreview: "Tip: Try the Desktop app. Run 'codex app' or visit",
    })).toEqual({ kind: "none", source: "none", text: "No response yet" });
  });

  it("uses the pane scrape only when the transcript and record offer nothing", () => {
    expect(conversationPreview({
      transcript: [{ role: "assistant", text: "Ran 1 shell command" }],
      replay: "The lease manager released the worktree.",
    })).toEqual({
      kind: "assistant",
      source: "terminal",
      text: "The lease manager released the worktree.",
    });
  });

  it("reports the echoed terminal prompt as a prompt rather than a reply", () => {
    expect(conversationPreview({
      replay: "❯ Rebuild the fleet header counters\n* Levitating… (2m 10s)",
    })).toEqual({
      kind: "prompt",
      source: "prompt",
      text: "Rebuild the fleet header counters",
    });
  });

  it("never treats an approval menu entry as the task prompt", () => {
    expect(conversationPreview({
      replay: [
        "Claude needs your permission to use Bash",
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. No",
        "Esc to cancel · Tab to amend",
      ].join("\n"),
    })).toEqual({ kind: "none", source: "none", text: "No response yet" });
  });

  it("takes the head of the reply, not its tail, and truncates on a word boundary", () => {
    const preview = conversationPreview({
      transcript: [{
        role: "assistant",
        text: "The reply begins here and should be previewed.\n\nThe final paragraph is not it.",
      }],
      maxLength: 30,
    });
    expect(preview.text).toBe("The reply begins here and…");
  });

  it("repairs a preview that starts mid-sentence", () => {
    expect(terminalProse("view. Some are already merged into main.")).toBe(
      "Some are already merged into main.",
    );
    expect(terminalProse("…those two into cyberdeck main.")).toBe("those two into cyberdeck main.");
  });
});

describe("preview primitives", () => {
  it("truncates on a word boundary and collapses a doubled ellipsis", () => {
    expect(truncatePreview("The quick brown fox jumps", 12)).toBe("The quick…");
    expect(truncatePreview("The quick brown fox", 40)).toBe("The quick brown fox");
    expect(truncatePreview("Already shortened…", 12)).toBe("Already…");
    expect(truncatePreview("Supercalifragilistic", 8)).toBe("Superca…");
  });

  it("reduces markdown to the prose it renders as", () => {
    expect(stripMarkdown("## **Bold** heading")).toBe("Bold heading");
    expect(stripMarkdown("- See [the docs](https://example.com) for `--flag`")).toBe(
      "See the docs for --flag",
    );
    expect(stripMarkdown("> quoted _emphasis_ and ~~strike~~")).toBe("quoted emphasis and strike");
  });
});
