import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { orchestratorNoticeDirectory } from "../../src/cli/notice-hook.js";
import { parseNoticeHookArguments, runNoticeHookEntry } from "../../src/cli/notice-hook-entry.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateWithNotice(overrides: Record<string, unknown> = {}): Promise<string> {
  const state = await mkdtemp(join(tmpdir(), "cyberdeck-notice-entry-"));
  directories.push(state);
  const directory = orchestratorNoticeDirectory(state, SESSION);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "notice.json"), JSON.stringify({
    schemaVersion: 1, controllerId: "orchestrator:fleet", sessionId: SESSION, cursor: 3, noticedCursor: 0,
    pending: 1, dropped: 0, text: "cyberdeck: 1 notifications pending (1 settled; oldest 2s) → cyberdeck_notifications_read",
    writtenAt: "2026-10-07T10:00:00.000Z", quietMinutes: 10, ...overrides,
  }));
  return state;
}

function io(state: string, extra: string[] = [], stdin = "") {
  const out: string[] = [];
  return {
    io: {
      argv: ["--actor-session", SESSION, "--state-directory", state, ...extra],
      stdin: async () => stdin,
      stdout: (text: string) => { out.push(text); },
      now: () => "2026-10-07T10:00:05.000Z",
    },
    out,
  };
}

describe("notice hook entry", () => {
  it("parses the fixed arguments and defaults the format and event", () => {
    expect(parseNoticeHookArguments(["--actor-session", SESSION, "--state-directory", "/s"])).toEqual({
      sessionId: SESSION, stateDirectory: "/s", format: "claude", event: "PostToolUse",
    });
    expect(parseNoticeHookArguments(["--actor-session", SESSION, "--state-directory", "/s", "--format", "cursor", "--event", "postToolUseFailure"]))
      .toMatchObject({ format: "cursor", event: "postToolUseFailure" });
    expect(parseNoticeHookArguments(["--actor-session", SESSION])).toBeUndefined();
    expect(parseNoticeHookArguments(["--actor-session", SESSION, "--state-directory", "/s", "--format", "bogus"])).toBeUndefined();
  });

  it("prints the provider envelope for the event it was given, once", async () => {
    const state = await stateWithNotice();
    const first = io(state, ["--event", "PostToolUseFailure"]);
    await runNoticeHookEntry(first.io);
    expect(JSON.parse(first.out[0]!)).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: expect.stringContaining("cyberdeck_notifications_read") },
    });
    const second = io(state);
    await runNoticeHookEntry(second.io);
    expect(second.out).toEqual([]);
  });

  it("repeats an unchanged notice only after the quiet interval has passed", async () => {
    const state = await stateWithNotice({ quietMinutes: 1 });
    const first = io(state);
    await runNoticeHookEntry(first.io);
    expect(first.out).toHaveLength(1);
    const soon = io(state);
    soon.io.now = () => "2026-10-07T10:00:30.000Z";
    await runNoticeHookEntry(soon.io);
    expect(soon.out).toEqual([]);
    const later = io(state);
    later.io.now = () => "2026-10-07T10:01:06.000Z";
    await runNoticeHookEntry(later.io);
    expect(later.out).toHaveLength(1);
  });

  it("stays silent on a Stop re-entry and prints on the first Stop", async () => {
    const state = await stateWithNotice();
    const reentry = io(state, ["--event", "Stop"], JSON.stringify({ stop_hook_active: true }));
    await runNoticeHookEntry(reentry.io);
    expect(reentry.out).toEqual([]);
    const first = io(state, ["--event", "Stop"], JSON.stringify({ stop_hook_active: false }));
    await runNoticeHookEntry(first.io);
    expect(JSON.parse(first.out[0]!).hookSpecificOutput.hookEventName).toBe("Stop");
  });

  it("prints nothing and never throws without a notice file, with bad arguments, or with a failing stdin", async () => {
    const state = await mkdtemp(join(tmpdir(), "cyberdeck-notice-entry-empty-"));
    directories.push(state);
    const empty = io(state);
    await expect(runNoticeHookEntry(empty.io)).resolves.toBeUndefined();
    expect(empty.out).toEqual([]);
    const bad = { argv: ["--nonsense"], stdin: async () => "", stdout: () => { throw new Error("never"); } };
    await expect(runNoticeHookEntry(bad)).resolves.toBeUndefined();
    const withNotice = await stateWithNotice();
    const failing = io(withNotice, ["--event", "Stop"]);
    failing.io.stdin = async () => { throw new Error("stdin closed"); };
    await runNoticeHookEntry(failing.io);
    expect(failing.out).toHaveLength(1);
  });
});
