import type { ProviderId } from "../../src/domain/session.js";

/** Provider redraw shape: clear/home, address each row, erase its old tail. No synthetic LF. */
export function redraw(rows: readonly string[], clear = "\u001b[2J\u001b[H"): string {
  return clear + rows.map((row, index) => `\u001b[${index + 1};1H${row}\u001b[K`).join("");
}

export const PROVIDER_SCREENS: readonly {
  provider: ProviderId; modal: readonly string[]; working: readonly string[];
  idle: readonly string[]; draft: readonly string[];
}[] = [
  {
    provider: "codex",
    modal: ["Would you like to run the following command?", "$ pnpm test", "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)"],
    working: ["• Inspecting the tests.", "• Working (0s • esc to interrupt)"],
    idle: ["• I fixed the permission prompt parsing.", "› Ask Codex to do anything", "? for shortcuts  98% context left"],
    draft: ["• Earlier answer.", "› operator's unsent draft", "tab to queue message  98% context left"],
  },
  {
    provider: "claude",
    modal: ["Claude needs your permission to use Bash", "  pnpm test", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "Esc to cancel · Tab to amend"],
    working: ["⏺ Inspecting the tests.", "✻ Cogitating… (4s · esc to interrupt)"],
    idle: ["⏺ I fixed the permission prompt parsing.", "────────────────────", "❯ ", "────────────────────", "⏵⏵ bypass permissions on (shift+tab to cycle)"],
    draft: ["⏺ Earlier answer.", "────────────────────", "❯ operator's unsent draft", "────────────────────", "tab to queue message"],
  },
  {
    provider: "cursor",
    modal: ["╭────────────────────────────╮", "│ Run this shell command?    │", "│ ❯ 1. Allow once            │", "│   2. Deny                  │", "│ Enter to confirm           │", "╰────────────────────────────╯"],
    working: ["Inspecting the tests.", "Composing 12 tokens", "ctrl+c to stop"],
    idle: ["I fixed the permission prompt parsing.", "→ Add a follow-up"],
    draft: ["Earlier answer.", "→ operator's unsent draft"],
  },
  {
    provider: "antigravity",
    modal: ["Do you trust the contents of this project?", "> Yes, I trust this folder", "  No, exit", "Enter to confirm · Esc to cancel"],
    working: ["Inspecting the tests.", "⣷ Thinking about the request"],
    idle: ["I fixed the permission prompt parsing.", "│ > Ask Gemini about this codebase │", "? for shortcuts plan · Gemini 3.6 Flash · low"],
    draft: ["Earlier answer.", "│ > operator's unsent draft │", "? for shortcuts plan · Gemini 3.6 Flash · low"],
  },
];
