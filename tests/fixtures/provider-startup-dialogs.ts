/**
 * Provider startup dialogs as the providers draw them, copied from their own sources: Codex 0.162.1's
 * `onboarding/trust_directory.rs` and `startup_hooks_review.rs` snapshot tests, Codex 0.153.4's
 * render functions, and the strings Claude Code 2.1.261 through 2.1.280 ship.
 */

export const CODEX_FOLDER_ACCESS = [
  "  Folder access",
  "  /workspace/project",
  "",
  "  Trust this folder? Codex can read, edit, and run files here,",
  "  subject to your permission settings. Folder settings can run code",
  "  automatically, even without a model request. Continue only if you",
  "  trust these files. Your trust decision will be saved.",
  "",
  "› 1. Trust and continue",
  "  2. Quit",
  "",
  "  enter continue and create sandbox · esc quit",
].join("\n");

export const CODEX_FOLDER_ACCESS_SUBDIRECTORY = [
  "  Folder access",
  "  /srv/remote/project/nested",
  "",
  "  Note: You’re in a subdirectory of a Git project. Trusting will",
  "  apply to the repository root:",
  "  /srv/remote/project",
  "",
  "  Trust this folder? Codex can read, edit, and run files here,",
  "  subject to your permission settings. Folder settings can run code",
  "  automatically, even without a model request. Continue only if you",
  "  trust these files. Your trust decision will be saved.",
  "",
  "› 1. Trust and continue",
  "  2. Back to Agent Command Center",
  "",
  "  enter continue · esc back",
].join("\n");

export const CODEX_FOLDER_ACCESS_KEEP_DIRECTORY = CODEX_FOLDER_ACCESS
  .replace("2. Quit", "2. Keep current directory")
  .replace("enter continue and create sandbox · esc quit", "enter continue · esc cancel");

export const CODEX_FOLDER_ACCESS_TRUST_ERROR = CODEX_FOLDER_ACCESS.replace(
  "  enter continue and create sandbox · esc quit",
  [
    "  Failed to set trust for /workspace/project: config/batchWrite",
    "  failed in TUI: Invalid configuration: features.fast_mode=true is",
    "  not supported; allowed set [fast_mode=false]",
    "",
    "  enter continue · esc quit",
  ].join("\n"),
);

export const CODEX_FOLDER_ACCESS_RESTRICTED = [
  "  Folder access",
  "  /workspace/project",
  "",
  "  Config, hooks, and exec policies from untrusted folders stay",
  "  disabled. Trusted project folders can still contribute settings.",
  "  Skills still load, and tools follow your permission settings.",
  "  Opening will not change saved trust.",
  "",
  "› 1. Open restricted",
  "  2. Back to Agent Command Center",
  "",
  "  enter continue · esc back",
].join("\n");

export const CODEX_FOLDER_ACCESS_EXISTING_TASK = [
  "  Folder access",
  "  /workspace/project",
  "",
  "  This existing task may retain settings and history, including",
  "  project configuration or hooks loaded while it was trusted. To use",
  "  restricted settings, start a new task. The folder's trust setting",
  "  will not change.",
  "",
  "› 1. Open existing task",
  "  2. Back to Agent Command Center",
  "",
  "  enter continue · esc back",
].join("\n");

/** Codex 0.120 through 0.153.4. */
export const CODEX_DIRECTORY_TRUST = [
  "> You are in /Users/op/repos/api",
  "",
  "  Do you trust the contents of this directory? Working with untrusted",
  "  contents comes with higher risk of prompt injection. Trusting the",
  "  directory allows project-local config, hooks, and exec policies to load.",
  "",
  "› 1. Yes, continue",
  "  2. No, quit",
  "",
  "  Press enter to continue",
].join("\n");

/** Codex 0.162.1's snapshot at 40 columns, where the third row wraps. */
export const CODEX_HOOK_REVIEW = [
  "  Hooks need review",
  "  2 hooks are new or changed.",
  "  Hooks can run outside the sandbox",
  "  after you trust them.",
  "",
  "› 1. Review hooks",
  "  2. Trust all and continue",
  "  3. Continue without trusting (hooks",
  "     won't run)",
  "",
  "  enter confirm · esc skip",
].join("\n");

export const CODEX_HOOK_REVIEW_0_153 = CODEX_HOOK_REVIEW.replace(
  "enter confirm · esc skip",
  "Press enter to confirm or esc to go back",
);

export const CODEX_HOOK_REVIEW_TRUSTING = CODEX_HOOK_REVIEW.replace(
  "  after you trust them.",
  "  after you trust them.\n  Trusting hooks...",
);

export const CLAUDE_TRUST = [
  " Accessing workspace:",
  "",
  " /Users/op/repos/api/worktrees/fix-races",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
  " well-known open source project, or work from your team). If not, take a moment to review",
  " what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
].join("\r\n");

const CLAUDE_GRANT_WARNING = [
  " This folder pre-approves 2 tool permissions in .claude/settings.json:",
  "   Bash(npm run *)",
  "   Bash(git push:*)",
  " These will apply without asking. Only proceed if you trust this configuration.",
  "",
  " Security guide",
].join("\r\n");

export const CLAUDE_TRUST_WARNED = CLAUDE_TRUST.replace(" Security guide", CLAUDE_GRANT_WARNING);

export const CLAUDE_TRUST_BACKSTOP = CLAUDE_TRUST_WARNED.replace(
  "❯ No, exit",
  "❯ No, continue without these permissions",
);

export const CLAUDE_TRUST_ACCESSIBLE = CLAUDE_TRUST
  .replace(" ❯ No, exit", " n. No, exit")
  .replace("   Yes, I trust this folder", " y. Yes, I trust this folder")
  .replace(" Enter to confirm · Esc to cancel", " Enter y/n: ");

/** The trust dialog older Claude builds drew, with its rows the other way round. */
export const CLAUDE_LEGACY_TRUST = [
  "╭──────────────────────────────────────────────╮",
  "│ Do you trust the files in this folder?       │",
  "│                                              │",
  "│ /Users/op/repos/api/worktrees/fix-races      │",
  "│                                              │",
  "│ ❯ 1. Yes, proceed                            │",
  "│   2. No, exit                                │",
  "╰──────────────────────────────────────────────╯",
].join("\r\n");

/** Captured from Claude: every word placed with a cursor-column move instead of a space. */
export const CLAUDE_TRUST_CAPTURED =
  "Quick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\n❯\u001b[3GNo,\u001b[7Gexit\nYes,\u001b[6GI\u001b[8Gtrust\u001b[14Gthis\u001b[19Gfolder\nEnter\u001b[7Gto\u001b[10Gconfirm\n";

/**
 * A Codex frame as ratatui writes it. Every run of cells is addressed with a cursor move instead
 * of a newline, and blank cells that did not change are never written — at worst every gap between
 * words, which is what `words` produces; `rows` keeps each row's inner spaces.
 */
export function codexRendered(frame: string, run: "words" | "rows" = "words"): string {
  const pattern = run === "words" ? /\S+/gu : /\S(?:.*\S)?/gu;
  return frame
    .split("\n")
    .map((line, row) => [...line.matchAll(pattern)]
      .map((match) => `\u001b[${row + 1};${match.index + 1}H${match[0]}`)
      .join(""))
    .join("");
}
