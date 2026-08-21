import { access, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { grantAllows, type CapabilityGrant } from "../../src/domain/capability.js";
import {
  pruneLegacyTranscript,
  ThreadTranscriptStore,
} from "../../src/persistence/thread-transcript-store.js";

// The store's incremental-scan behaviour is asserted by watching the `start` byte offset every
// createReadStream call opens at. Node's own ESM namespace cannot be spied on directly, so the
// module is mocked wholesale and every export but this one delegates straight to the real thing.
const readStreamStarts = vi.hoisted(() => [] as Array<{ path: string; start: number }>);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (path: string, options?: { start?: number }) => {
      readStreamStarts.push({ path, start: options?.start ?? 0 });
      return actual.createReadStream(path, options);
    },
  };
});

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

  it("observes provider-turn candidates without writing semantic transcript truth", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const store = new ThreadTranscriptStore(root, {
      now: () => "2026-08-20T12:00:00.000Z",
    });

    await expect(store.observeProviderTurns({
      sessionId: SESSION_ONE,
      provider: "cursor",
      cwd: "/tmp/repo",
      createdAt: "2026-08-20T11:59:00.000Z",
      turnNumber: 3,
      fallbackText: "candidate only",
    })).resolves.toEqual({
      sessionId: SESSION_ONE,
      provider: "cursor",
      turnNumber: 3,
      turns: [{
        providerTurnId: "fallback:3",
        providerOccurredAt: "2026-08-20T12:00:00.000Z",
        text: "candidate only",
        transport: "terminal-replay-fallback",
      }],
    });
    await expect(store.read(SESSION_ONE)).resolves.toEqual({ events: [], nextCursor: 0 });
  });

  it("commits an observed provider turn with the existing semantic event shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const store = new ThreadTranscriptStore(root, {
      now: () => "2026-08-20T12:00:00.000Z",
      idFactory: () => "00000001-0000-4000-8000-000000000000",
    });
    const observation = await store.observeProviderTurns({
      sessionId: SESSION_ONE,
      provider: "cursor",
      cwd: "/tmp/repo",
      createdAt: "2026-08-20T11:59:00.000Z",
      turnNumber: 3,
      fallbackText: "committed result",
    });

    await expect(store.commitProviderTurns(observation)).resolves.toEqual([{
      id: "00000001-0000-4000-8000-000000000000",
      cursor: 1,
      sessionId: SESSION_ONE,
      occurredAt: "2026-08-20T12:00:00.000Z",
      kind: "turn",
      source: "provider",
      text: "committed result",
      data: {
        semantic: true,
        semanticTurnId: "cursor:fallback:3",
        provider: "cursor",
        transport: "terminal-replay-fallback",
        originalLength: 16,
        turnNumber: 3,
        providerOccurredAt: "2026-08-20T12:00:00.000Z",
      },
    }]);
    await expect(store.read(SESSION_ONE)).resolves.toMatchObject({
      events: [{ text: "committed result", data: { semanticTurnId: "cursor:fallback:3" } }],
    });
    await expect(store.observeProviderTurns({
      sessionId: SESSION_ONE,
      provider: "cursor",
      cwd: "/tmp/repo",
      createdAt: "2026-08-20T11:59:00.000Z",
      turnNumber: 3,
      fallbackText: "must be deduplicated",
    })).resolves.toMatchObject({ turns: [] });
  });

  it("serializes concurrent commits, appends once, and acknowledges both durable owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    let id = 0;
    const store = new ThreadTranscriptStore(root, {
      now: () => "2026-08-20T12:00:00.000Z",
      idFactory: () => `${String(++id).padStart(8, "0")}-0000-4000-8000-000000000000`,
    });
    const input = {
      sessionId: SESSION_ONE,
      provider: "cursor",
      cwd: "/tmp/repo",
      createdAt: "2026-08-20T11:59:00.000Z",
      turnNumber: 1,
      fallbackText: "one durable result",
    };
    const [first, second] = await Promise.all([
      store.observeProviderTurns(input),
      store.observeProviderTurns(input),
    ]);

    const committed = await Promise.all([
      store.commitProviderTurns(first),
      store.commitProviderTurns(second),
    ]);

    expect(committed.map((events) => events.length)).toEqual([1, 1]);
    expect(committed[1]).toMatchObject([{
      text: "one durable result",
      data: {
        semanticTurnId: "cursor:fallback:1",
        transport: "terminal-replay-fallback",
        turnNumber: 1,
      },
    }]);
    await expect(store.read(SESSION_ONE)).resolves.toMatchObject({
      events: [{ text: "one durable result", data: { semanticTurnId: "cursor:fallback:1" } }],
      nextCursor: 1,
    });
  });

  it("keeps later turn ordinals aligned when a concurrent commit overlaps a durable prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const store = new ThreadTranscriptStore(root, {
      now: () => "2026-08-20T12:00:00.000Z",
    });
    const firstTurn = {
      providerTurnId: "fallback:1",
      providerOccurredAt: "2026-08-20T12:00:00.000Z",
      text: "first durable result",
      transport: "terminal-replay-fallback" as const,
    };
    const first = {
      sessionId: SESSION_ONE,
      provider: "cursor",
      turnNumber: 1,
      turns: [firstTurn],
    };
    const overlapping = {
      ...first,
      turns: [firstTurn, {
        providerTurnId: "fallback:2",
        providerOccurredAt: "2026-08-20T12:01:00.000Z",
        text: "second durable result",
        transport: "terminal-replay-fallback" as const,
      }],
    };

    const [firstReceipt, overlappingReceipt] = await Promise.all([
      store.commitProviderTurns(first),
      store.commitProviderTurns(overlapping),
    ]);

    expect(firstReceipt).toHaveLength(1);
    expect(overlappingReceipt).toHaveLength(2);
    await expect(store.read(SESSION_ONE)).resolves.toMatchObject({
      events: [
        { data: { semanticTurnId: "cursor:fallback:1", turnNumber: 1 } },
        { data: { semanticTurnId: "cursor:fallback:2", turnNumber: 2 } },
      ],
      nextCursor: 2,
    });
  });

  it("keeps captureProviderTurns as observe-then-commit compatibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const store = new ThreadTranscriptStore(root, {
      now: () => "2026-08-20T12:00:00.000Z",
    });

    await expect(store.captureProviderTurns({
      sessionId: SESSION_ONE,
      provider: "antigravity",
      cwd: "/tmp/repo",
      createdAt: "2026-08-20T11:59:00.000Z",
      turnNumber: 2,
      fallbackText: "compatibility result",
    })).resolves.toMatchObject([{
      kind: "turn",
      source: "provider",
      text: "compatibility result",
      data: {
        semanticTurnId: "antigravity:fallback:2",
        turnNumber: 2,
        transport: "terminal-replay-fallback",
      },
    }]);
    await expect(store.read(SESSION_ONE)).resolves.toMatchObject({
      events: [{ text: "compatibility result" }],
    });
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

  it("reads the model a Claude session is running now, not the one it opened with", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const projects = join(root, "claude-projects");
    const cwd = "/tmp/repo";
    await mkdir(join(projects, cwd.replace(/[^A-Za-z0-9-]/gu, "-")), { recursive: true });
    await writeFile(
      join(projects, cwd.replace(/[^A-Za-z0-9-]/gu, "-"), `${SESSION_ONE}.jsonl`),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-16T10:00:00.000Z",
          effort: "low",
          message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "a" }] },
        }),
        // The operator switched model inside the CLI; the next turn is the first to say so.
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-08-16T10:05:00.000Z",
          effort: "high",
          message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "b" }] },
        }),
        "",
      ].join("\n"),
    );
    const store = new ThreadTranscriptStore(root, { claudeProjectsDirectory: projects });

    await expect(store.readObservedModel({
      sessionId: SESSION_ONE,
      provider: "claude",
      cwd,
      createdAt: "2026-08-16T10:00:00.000Z",
      turnNumber: 2,
    })).resolves.toEqual({
      model: "claude-opus-5",
      effort: "high",
      observedAt: "2026-08-16T10:05:00.000Z",
    });
  });

  it("observes no model for a provider that writes no transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const store = new ThreadTranscriptStore(root);

    await expect(store.readObservedModel({
      sessionId: SESSION_ONE,
      provider: "cursor",
      cwd: "/tmp/repo",
      createdAt: "2026-08-16T10:00:00.000Z",
      turnNumber: 1,
    })).resolves.toBeUndefined();
  });

  it("scans only the bytes appended since the previous observed-model read", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const projects = join(root, "claude-projects");
    const cwd = "/tmp/repo";
    const dir = join(projects, cwd.replace(/[^A-Za-z0-9-]/gu, "-"));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${SESSION_ONE}.jsonl`);
    const frameOne = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-16T10:00:00.000Z",
      effort: "low",
      message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "a" }] },
    });
    await writeFile(path, `${frameOne}\n`);
    const store = new ThreadTranscriptStore(root, { claudeProjectsDirectory: projects });
    const input = {
      sessionId: SESSION_ONE,
      provider: "claude",
      cwd,
      createdAt: "2026-08-16T10:00:00.000Z",
      turnNumber: 1,
    };

    // Every createReadStream call against this file is a scan; its `start` offset is the byte
    // position the store believed it had already consumed.
    readStreamStarts.length = 0;
    const startsFor = () => readStreamStarts
      .filter((call) => call.path === path)
      .map((call) => call.start);

    await expect(store.readObservedModel(input)).resolves.toEqual({
      model: "claude-sonnet-5",
      effort: "low",
      observedAt: "2026-08-16T10:00:00.000Z",
    });
    expect(startsFor()).toEqual([0]);

    const sizeAfterFirstRead = (await stat(path)).size;
    const frameTwo = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-16T10:05:00.000Z",
      effort: "high",
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "b" }] },
    });
    await writeFile(path, `${frameOne}\n${frameTwo}\n`);

    await expect(store.readObservedModel({ ...input, turnNumber: 2 })).resolves.toEqual({
      model: "claude-opus-5",
      effort: "high",
      observedAt: "2026-08-16T10:05:00.000Z",
    });
    // The second scan started exactly where the first left off: only frameTwo's bytes were read,
    // never frameOne's again.
    expect(startsFor()).toEqual([0, sizeAfterFirstRead]);
  });

  it("resets the cursor and re-scans from the start when a session's resolved transcript path changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const codexRoot = join(root, "codex-sessions");
    const day = join(codexRoot, "2026", "07", "25");
    await mkdir(day, { recursive: true });
    const cwd = "/tmp/repo";
    const createdAt = "2026-07-25T10:00:00.000Z";
    // The first-matched file carries no model frame at all, so the store never locks its
    // `nativePaths` mapping onto it — leaving room for a later, closer-matching file to win.
    await writeFile(join(day, "rollout-a.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-25T10:00:20.000Z",
        payload: {
          id: "019f0000-0000-7000-8000-00000000000a",
          timestamp: "2026-07-25T10:00:20.000Z",
          cwd,
          originator: "codex-tui",
        },
      }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-07-25T10:00:21.000Z", payload: { type: "other" } }),
      "",
    ].join("\n"));
    const store = new ThreadTranscriptStore(root, { codexSessionsDirectory: codexRoot });
    const input = { sessionId: SESSION_ONE, provider: "codex", cwd, createdAt, turnNumber: 1 };

    await expect(store.readObservedModel(input)).resolves.toBeUndefined();

    // A second, exactly-timestamped rollout appears for the same session — the case a Claude
    // /clear rebind or a fresh Codex resume produces: the same session now resolves to a different
    // physical file.
    await writeFile(join(day, "rollout-b.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        timestamp: createdAt,
        payload: {
          id: "019f0000-0000-7000-8000-00000000000b",
          timestamp: createdAt,
          cwd,
          originator: "codex-tui",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-07-25T10:00:01.000Z",
        payload: { model: "gpt-6-codex", effort: "medium" },
      }),
      "",
    ].join("\n"));

    await expect(store.readObservedModel({ ...input, turnNumber: 2 })).resolves.toEqual({
      model: "gpt-6-codex",
      effort: "medium",
      observedAt: "2026-07-25T10:00:01.000Z",
    });
  });

  it("resets the cursor and re-scans from the start when the transcript shrinks (truncation or rotation)", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    const projects = join(root, "claude-projects");
    const cwd = "/tmp/repo";
    const dir = join(projects, cwd.replace(/[^A-Za-z0-9-]/gu, "-"));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${SESSION_ONE}.jsonl`);
    await writeFile(path, [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-16T10:00:00.000Z",
        message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "a" }] },
      }),
      "padding-line-to-push-the-cursor-well-past-the-shrunken-file-size",
      "",
    ].join("\n"));
    const store = new ThreadTranscriptStore(root, { claudeProjectsDirectory: projects });
    const input = {
      sessionId: SESSION_ONE,
      provider: "claude",
      cwd,
      createdAt: "2026-08-16T10:00:00.000Z",
      turnNumber: 1,
    };
    await expect(store.readObservedModel(input)).resolves.toMatchObject({ model: "claude-sonnet-5" });

    // The file is rewritten shorter than the cursor's remembered offset — a rotation or a fresh
    // session log reusing the name.
    await writeFile(path, [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-16T11:00:00.000Z",
        message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "b" }] },
      }),
      "",
    ].join("\n"));

    await expect(store.readObservedModel({ ...input, turnNumber: 2 })).resolves.toEqual({
      model: "claude-opus-5",
      observedAt: "2026-08-16T11:00:00.000Z",
    });
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
