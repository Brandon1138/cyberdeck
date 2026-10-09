import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeUserSettingsPath,
  readClaudeOperatorVoice,
} from "../../src/providers/claude/operator-voice.js";

const directories: string[] = [];

function settingsFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "cyberdeck-operator-voice-"));
  directories.push(directory);
  const path = join(directory, "settings.json");
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("readClaudeOperatorVoice", () => {
  it("copies only the voice keys, voice whole", async () => {
    const path = settingsFile(JSON.stringify({
      model: "opus",
      permissions: { deny: ["Bash(rm:*)"] },
      voiceEnabled: true,
      voice: { enabled: true, mode: "hold", future: 1 },
    }));
    expect(await readClaudeOperatorVoice(path)).toEqual({
      voiceEnabled: true,
      voice: { enabled: true, mode: "hold", future: 1 },
    });
  });

  it("carries either key on its own", async () => {
    expect(await readClaudeOperatorVoice(settingsFile(JSON.stringify({ voiceEnabled: false }))))
      .toEqual({ voiceEnabled: false });
    expect(await readClaudeOperatorVoice(settingsFile(JSON.stringify({ voice: { enabled: true } }))))
      .toEqual({ voice: { enabled: true } });
  });

  it.each([
    ["no voice keys", JSON.stringify({ model: "opus" })],
    ["malformed JSON", "{ voiceEnabled: true"],
    ["a mistyped key", JSON.stringify({ voiceEnabled: "yes" })],
    ["a non-object root", "[]"],
  ])("carries nothing for %s", async (_label, content) => {
    expect(await readClaudeOperatorVoice(settingsFile(content))).toBeUndefined();
  });

  it("carries nothing for a missing file", async () => {
    expect(await readClaudeOperatorVoice(join(tmpdir(), "cyberdeck-absent", "settings.json")))
      .toBeUndefined();
  });
});

describe("claudeUserSettingsPath", () => {
  it("follows CLAUDE_CONFIG_DIR, and ~/.claude without it", () => {
    expect(claudeUserSettingsPath({ CLAUDE_CONFIG_DIR: "/config" })).toBe("/config/settings.json");
    expect(claudeUserSettingsPath({})).toBe(join(homedir(), ".claude", "settings.json"));
  });
});
