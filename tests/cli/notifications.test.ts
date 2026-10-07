import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { orchestratorNoticeDirectory, runNoticeHook } from "../../src/cli/notifications.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cyberdeck-notice-hook-"));
  directories.push(path);
  return path;
}

async function writeNotice(state: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = orchestratorNoticeDirectory(state, SESSION);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "notice.json"), JSON.stringify({
    schemaVersion: 1,
    controllerId: "orchestrator:fleet",
    sessionId: SESSION,
    cursor: 5,
    noticedCursor: 2,
    pending: 1,
    dropped: 0,
    text: "cyberdeck: 1 notification pending (1 settled; oldest 3s) → cyberdeck_notifications_read",
    writtenAt: "2026-10-07T10:00:00.000Z",
    ...overrides,
  }));
  return directory;
}

describe("cyberdeck notifications notice (provider hook)", () => {
  it("prints nothing and does not throw when no notice file exists", async () => {
    const state = await stateDirectory();
    await expect(runNoticeHook({ sessionId: SESSION, stateDirectory: state, format: "claude" }))
      .resolves.toBeUndefined();
  });

  it("prints nothing for an unreadable or malformed file", async () => {
    const state = await stateDirectory();
    const directory = orchestratorNoticeDirectory(state, SESSION);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "notice.json"), "{not json");
    await expect(runNoticeHook({ sessionId: SESSION, stateDirectory: state, format: "claude" }))
      .resolves.toBeUndefined();
    await writeFile(join(directory, "notice.json"), JSON.stringify({ schemaVersion: 9 }));
    await expect(runNoticeHook({ sessionId: SESSION, stateDirectory: state, format: "codex" }))
      .resolves.toBeUndefined();
  });

  it("prints the provider envelope once, then records the shown cursor and stays quiet", async () => {
    const state = await stateDirectory();
    const directory = await writeNotice(state);
    const first = await runNoticeHook({
      sessionId: SESSION,
      stateDirectory: state,
      format: "claude",
      now: () => "2026-10-07T10:00:01.000Z",
    });
    expect(JSON.parse(first!)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "cyberdeck: 1 notification pending (1 settled; oldest 3s) → cyberdeck_notifications_read",
      },
    });
    expect(JSON.parse(await readFile(join(directory, "notice-shown.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      cursor: 5,
      shownAt: "2026-10-07T10:00:01.000Z",
      via: "claude",
    });
    await expect(runNoticeHook({ sessionId: SESSION, stateDirectory: state, format: "claude" }))
      .resolves.toBeUndefined();
    // A newer head is shown again; the cursor the broker already piggybacked is not.
    await writeNotice(state, { cursor: 6 });
    const second = await runNoticeHook({ sessionId: SESSION, stateDirectory: state, format: "cursor" });
    expect(JSON.parse(second!)).toHaveProperty("additional_context");
    await writeNotice(state, { cursor: 7, noticedCursor: 7 });
    await expect(runNoticeHook({ sessionId: SESSION, stateDirectory: state, format: "cursor" }))
      .resolves.toBeUndefined();
  });

  it("ignores a notice file written for another session", async () => {
    const state = await stateDirectory();
    await writeNotice(state, { sessionId: "22222222-2222-4222-8222-222222222222" });
    await expect(runNoticeHook({ sessionId: SESSION, stateDirectory: state, format: "claude" }))
      .resolves.toBeUndefined();
  });
});
