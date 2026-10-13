import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { CodexProviderAdapter } from "../../src/providers/codex.js";
import { CodexConversationBindingStore } from "../../src/persistence/codex-conversation-bindings.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { codexSessionMarker } from "../../src/providers/codex/native-session-identity.js";

const syncReads = vi.hoisted(() => ({ rollouts: [] as number[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const rolloutFds = new Set<number>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (String(args[0]).endsWith(".jsonl")) rolloutFds.add(fd);
      return fd;
    },
    closeSync: (fd: number) => { rolloutFds.delete(fd); return actual.closeSync(fd); },
    readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      if (rolloutFds.has(fd)) syncReads.rollouts.push(length);
      return actual.readSync(fd, buffer, offset, length, position);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).endsWith(".jsonl")) throw new Error("Full synchronous rollout read is forbidden");
      return actual.readFileSync(...args);
    },
  };
});

const id = "11111111-1111-4111-8111-111111111111", cwd = "/tmp/repo", createdAt = "2026-10-13T10:00:00.000Z";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const line = (frame: unknown) => JSON.stringify(frame) + "\n";
const marker = line({ type: "response_item", payload: { type: "message", role: "developer",
  content: [{ type: "input_text", text: codexSessionMarker(id) }] } });
const metadata = line({ type: "session_meta", payload: { id: "native-exact", cwd, timestamp: createdAt, originator: "codex-tui" } });
const largeFrame = line({ type: "response_item", payload: { type: "message", role: "assistant",
  content: [{ type: "output_text", text: "large body ".repeat(32_000) }] } });
async function fixture(contents: string) {
  const root = await mkdtemp(join(tmpdir(), "codex-bounded-resume-")); roots.push(root);
  const sessions = join(root, "sessions"), day = join(sessions, "2026", "10", "13");
  await mkdir(day, { recursive: true });
  const path = join(day, "rollout.jsonl");
  await writeFile(path, contents);
  const session = { id, provider: "codex", cwd, createdAt, sandbox: "read-only" } as SessionRecord;
  syncReads.rollouts.length = 0;
  return { root, sessions, path, session };
}

describe("bounded exact Codex resume", () => {
  it("resumes an exact launch marker from a bounded header without synchronously reading the growing body", async () => {
    const f = await fixture(metadata + marker + largeFrame);
    expect(new CodexProviderAdapter({ sessionsDirectory: f.sessions }).buildResumeSpec(f.session).args.at(-1)).toBe("native-exact");
    expect(syncReads.rollouts).toEqual([64 * 1024]);
  });

  it("uses asynchronous capture's durable binding when the exact marker is beyond the synchronous header bound", async () => {
    const f = await fixture(metadata + largeFrame + marker);
    const bindings = new CodexConversationBindingStore(f.root);
    const adapter = new CodexProviderAdapter({ sessionsDirectory: f.sessions, codexConversations: bindings });
    expect(() => adapter.buildResumeSpec(f.session)).toThrow("one exact");
    const store = new ThreadTranscriptStore(f.root, { codexSessionsDirectory: f.sessions, codexConversations: bindings });
    expect(await store.observeProviderTurns({ sessionId: id, provider: "codex", cwd, createdAt, turnNumber: 1 }))
      .toMatchObject({ nativeSourceAvailable: true, nativeSessionId: "native-exact", turns: [] });
    syncReads.rollouts.length = 0;
    expect(adapter.buildResumeSpec(f.session).args.at(-1)).toBe("native-exact");
    expect(syncReads.rollouts).toEqual([64 * 1024]);
  });

  it("does not trust a marker's incomplete final JSONL frame", async () => {
    const f = await fixture(metadata + marker.slice(0, -1));
    expect(() => new CodexProviderAdapter({ sessionsDirectory: f.sessions }).buildResumeSpec(f.session)).toThrow("one exact");
    expect(syncReads.rollouts).toEqual([64 * 1024]);
  });
});
