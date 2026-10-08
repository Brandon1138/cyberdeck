import { describe, expect, it } from "vitest";
import { NOTICE_HOOK_TIMEOUT_SECONDS, noticeHookCommandLine, noticeHookEntryPath } from "../../src/providers/notice-hook-command.js";
import { claudeTranscriptHookCommandLine } from "../../src/providers/claude/transcript-hook.js";

describe("notice hook command", () => {
  it("places the entry beside the CLI entry in either layout", () => {
    expect(noticeHookEntryPath("/opt/cyberdeck/dist/src/cli.js")).toBe("/opt/cyberdeck/dist/src/cli/notice-hook-entry.js");
    expect(noticeHookEntryPath("/repo/src/cli.ts")).toBe("/repo/src/cli/notice-hook-entry.ts");
  });

  it("renders a shell-safe command with every argument fixed at launch", () => {
    expect(noticeHookCommandLine({
      nodePath: "/usr/local/bin/node",
      cliPath: "/opt/cyberdeck/dist/src/cli.js",
      sessionId: "11111111-1111-4111-8111-111111111111",
      stateDirectory: "/Users/me/Library/Application Support/Cyberdeck",
      format: "claude",
      event: "PostToolUse",
    })).toBe(
      "/usr/local/bin/node /opt/cyberdeck/dist/src/cli/notice-hook-entry.js --actor-session 11111111-1111-4111-8111-111111111111 --state-directory '/Users/me/Library/Application Support/Cyberdeck' --format claude --event PostToolUse",
    );
    expect(NOTICE_HOOK_TIMEOUT_SECONDS).toBe(2);
  });

  it("quotes exactly as the transcript hook does", () => {
    const transcript = claudeTranscriptHookCommandLine({
      nodePath: "/usr/local/bin/node", cliPath: "/opt/cyberdeck/dist/src/cli.js",
      sessionId: "11111111-1111-4111-8111-111111111111", stateDirectory: "/it's here",
    });
    expect(transcript).toContain("'/it'\\''s here'");
  });
});
