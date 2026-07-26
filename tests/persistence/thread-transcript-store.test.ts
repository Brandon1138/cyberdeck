import { access, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grantAllows, type CapabilityGrant } from "../../src/domain/capability.js";
import {
  pruneLegacyTranscript,
  ThreadTranscriptStore,
} from "../../src/persistence/thread-transcript-store.js";

const SESSION_ONE = "11111111-1111-4111-8111-111111111111";
const SESSION_TWO = "22222222-2222-4222-8222-222222222222";

describe("ThreadTranscriptStore", () => {
  it("persists ordered thread events and reads global changes by cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    let id = 0;
    const store = new ThreadTranscriptStore(root, {
      now: () => "2026-07-22T12:00:00.000Z",
      idFactory: () => `${String(++id).padStart(8, "0")}-0000-4000-8000-000000000000`,
    });
    await store.append({ sessionId: SESSION_ONE, kind: "prompt", source: "human", text: "inspect" });
    await store.append({ sessionId: SESSION_TWO, kind: "output", source: "provider", text: "done" });

    await expect(store.read(SESSION_ONE)).resolves.toMatchObject({
      events: [{ cursor: 1, text: "inspect" }],
      nextCursor: 1,
    });
    await expect(store.changes(1)).resolves.toMatchObject({
      events: [{ cursor: 2, sessionId: SESSION_TWO, text: "done" }],
      nextCursor: 2,
    });

    const reopened = new ThreadTranscriptStore(root);
    await expect(reopened.changes()).resolves.toMatchObject({
      events: [{ cursor: 1 }, { cursor: 2 }],
      nextCursor: 2,
    });
  });

  it("ignores the untouched legacy raw transcript during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const threads = join(root, "threads");
    await mkdir(threads, { recursive: true });
    await writeFile(join(threads, "transcript.jsonl"), "not-json\n".repeat(10_000));

    const store = new ThreadTranscriptStore(root);
    await expect(store.init()).resolves.toBeUndefined();
    await expect(store.changes()).resolves.toEqual({ events: [], nextCursor: 0 });
    expect(store.path).toBe(join(threads, "semantic-transcript.jsonl"));
  });

  it("rotates bounded semantic segments and paginates retained events exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const store = new ThreadTranscriptStore(root, {
      maxBytes: 1_024,
      retainedFiles: 10,
    });
    for (let index = 1; index <= 6; index += 1) {
      await store.append({
        sessionId: SESSION_ONE,
        kind: "turn",
        source: "provider",
        text: `turn-${index}-${"x".repeat(600)}`,
      });
    }

    const texts: string[] = [];
    let cursor = 0;
    while (true) {
      const page = await store.read(SESSION_ONE, cursor, 1);
      if (page.events.length === 0) break;
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
      texts.push(page.events[0]!.text!);
    }
    expect(texts.map((text) => text.slice(0, 6))).toEqual([
      "turn-1",
      "turn-2",
      "turn-3",
      "turn-4",
      "turn-5",
      "turn-6",
    ]);
    const segments = (await readdir(join(root, "threads")))
      .filter((name) => name.startsWith("semantic-transcript"));
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect((await stat(join(root, "threads", segment))).size).toBeLessThanOrEqual(1_024);
    }
  });

  it("parses Codex task_complete frames as provider-native semantic turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const codexRoot = join(root, "codex-sessions");
    const day = join(codexRoot, "2026", "07", "25");
    await mkdir(day, { recursive: true });
    await writeFile(join(day, "rollout.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-25T10:00:00.000Z",
        payload: {
          id: "019f0000-0000-7000-8000-000000000001",
          timestamp: "2026-07-25T10:00:00.000Z",
          cwd: "/tmp/repo",
          originator: "codex-tui",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-25T10:00:03.000Z",
        payload: {
          type: "message",
          role: "assistant",
          phase: "commentary",
          content: [{ type: "output_text", text: "intermediate text" }],
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-25T10:00:04.000Z",
        payload: {
          type: "task_complete",
          turn_id: "019f0000-0000-7000-8000-000000000002",
          last_agent_message: "Codex final answer",
        },
      }),
      "",
    ].join("\n"));
    const store = new ThreadTranscriptStore(root, { codexSessionsDirectory: codexRoot });

    await expect(store.captureProviderTurns({
      sessionId: SESSION_ONE,
      provider: "codex",
      cwd: "/tmp/repo",
      createdAt: "2026-07-25T10:00:00.000Z",
      turnNumber: 1,
    })).resolves.toMatchObject([{
      kind: "turn",
      text: "Codex final answer",
      data: { transport: "provider-native" },
    }]);
  });

  it("requires explicit confirmation before pruning a legacy transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const legacy = join(root, "threads", "transcript.jsonl");
    await mkdir(join(root, "threads"), { recursive: true });
    await writeFile(legacy, "legacy");

    await expect(pruneLegacyTranscript(root, false)).rejects.toThrow(
      "--confirm-delete-legacy-transcript",
    );
    await expect(access(legacy)).resolves.toBeUndefined();
    await expect(pruneLegacyTranscript(root, true)).resolves.toEqual({
      path: legacy,
      removed: true,
    });
    await expect(access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("capability grants", () => {
  const workspaceGrant: CapabilityGrant = {
    subjectSessionId: SESSION_ONE,
    capabilities: ["thread.list", "thread.read", "thread.enqueue"],
    scope: { kind: "workspace", cwd: "/repo/one" },
  };

  it("keeps capability and scope independent", () => {
    expect(grantAllows(workspaceGrant, "thread.read", { cwd: "/repo/one" })).toBe(true);
    expect(grantAllows(workspaceGrant, "thread.read", { cwd: "/repo/two" })).toBe(false);
    expect(grantAllows(workspaceGrant, "worker.start", { cwd: "/repo/one" })).toBe(false);
  });
});
