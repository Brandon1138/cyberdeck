import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeConversationBindingStore,
} from "../../src/persistence/claude-conversation-bindings.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import {
  claudeTranscriptHookSettings,
  runClaudeTranscriptRebind,
} from "../../src/providers/claude/transcript-hook.js";

const WORKER_ONE = "11111111-1111-4111-8111-111111111111";
const WORKER_TWO = "22222222-2222-4222-8222-222222222222";
const CLEARED_CONVERSATION = "33333333-3333-4333-8333-333333333333";
const REBOUND_CONVERSATION = "44444444-4444-4444-8444-444444444444";
const WORKTREE = "/tmp/shared-worktree";

function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/gu, "-");
}

function assistantFrame(id: string, text: string, at: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: at,
    message: {
      id,
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  });
}

function clearFrame(at: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: at,
    message: {
      role: "user",
      content:
        "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>",
    },
  });
}

/** A tool result that merely quotes the marker must never be read as the operator clearing. */
function quotedClearFrame(at: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: at,
    toolUseResult: { stdout: "match" },
    message: {
      role: "user",
      content: [{
        type: "text",
        text: "grep output: transcript.jsonl:<command-name>/clear</command-name>",
      }],
    },
  });
}

async function writeTranscript(
  projects: string,
  cwd: string,
  conversationId: string,
  frames: string[],
): Promise<string> {
  const directory = join(projects, projectSlug(cwd));
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${conversationId}.jsonl`);
  await writeFile(path, `${frames.join("\n")}\n`);
  return path;
}

interface Harness {
  root: string;
  projects: string;
  bindings: ClaudeConversationBindingStore;
  store: () => ThreadTranscriptStore;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-claude-rebind-"));
  const projects = join(root, "claude-projects");
  await mkdir(projects, { recursive: true });
  return {
    root,
    projects,
    bindings: new ClaudeConversationBindingStore(root),
    // A fresh store is exactly what a broker restart produces: nothing is carried in memory.
    store: () => new ThreadTranscriptStore(root, { claudeProjectsDirectory: projects }),
  };
}

function capture(sessionId: string, turnNumber: number) {
  return {
    sessionId,
    provider: "claude",
    cwd: WORKTREE,
    createdAt: "2026-08-15T10:00:00.000Z",
    turnNumber,
  };
}

describe("Claude transcript rebinding after /clear", () => {
  it("follows the new conversation file a SessionStart clear hook reports", async () => {
    const context = await harness();
    await writeTranscript(context.projects, WORKTREE, WORKER_ONE, [
      assistantFrame("msg_before", "before the clear", "2026-08-15T10:00:01.000Z"),
      clearFrame("2026-08-15T10:00:02.000Z"),
    ]);
    const store = context.store();

    // `allowFallback` is the caller's last attempt after the native read came back empty.
    const dark = { ...capture(WORKER_ONE, 1), allowFallback: true };
    await expect(store.captureProviderTurns(dark)).resolves.toMatchObject([{
      // Detected, not silent: the abandoned file is refused and the turn is labelled.
      data: {
        transport: "terminal-replay-fallback",
        claudeTranscriptStatus: "cleared-unbound",
      },
    }]);
    expect(store.claudeTranscriptStatus(WORKER_ONE)).toBe("cleared-unbound");

    const rebound = await writeTranscript(
      context.projects,
      WORKTREE,
      REBOUND_CONVERSATION,
      [assistantFrame("msg_after", "after the clear", "2026-08-15T10:05:00.000Z")],
    );
    await runClaudeTranscriptRebind({
      sessionId: WORKER_ONE,
      payload: JSON.stringify({
        session_id: REBOUND_CONVERSATION,
        transcript_path: rebound,
        cwd: WORKTREE,
        hook_event_name: "SessionStart",
        source: "clear",
      }),
      store: context.bindings,
    });

    await expect(store.captureProviderTurns(capture(WORKER_ONE, 2))).resolves.toMatchObject([{
      text: "after the clear",
      data: { transport: "provider-native" },
    }]);
    expect(store.claudeTranscriptStatus(WORKER_ONE)).toBe("bound");
  });

  it("keeps two workers sharing one worktree on their own conversations", async () => {
    const context = await harness();
    const oneRebound = await writeTranscript(
      context.projects,
      WORKTREE,
      REBOUND_CONVERSATION,
      [assistantFrame("msg_one", "worker one after clear", "2026-08-15T10:05:00.000Z")],
    );
    await writeTranscript(context.projects, WORKTREE, WORKER_TWO, [
      assistantFrame("msg_two", "worker two never cleared", "2026-08-15T10:06:00.000Z"),
    ]);
    await writeTranscript(context.projects, WORKTREE, WORKER_ONE, [
      clearFrame("2026-08-15T10:04:00.000Z"),
    ]);
    await runClaudeTranscriptRebind({
      sessionId: WORKER_ONE,
      payload: JSON.stringify({
        session_id: REBOUND_CONVERSATION,
        transcript_path: oneRebound,
        cwd: WORKTREE,
        source: "clear",
      }),
      store: context.bindings,
    });
    const store = context.store();

    await expect(store.captureProviderTurns(capture(WORKER_ONE, 2))).resolves.toMatchObject([
      { text: "worker one after clear" },
    ]);
    await expect(store.captureProviderTurns(capture(WORKER_TWO, 1))).resolves.toMatchObject([
      { text: "worker two never cleared" },
    ]);
    // The newest file in this cwd belongs to worker two and must never reach worker one.
    await expect(store.read(WORKER_ONE)).resolves.toMatchObject({
      events: [{ text: "worker one after clear" }],
    });
  });

  it("resumes a rebound conversation across a broker restart", async () => {
    const context = await harness();
    await writeTranscript(context.projects, WORKTREE, WORKER_ONE, [
      clearFrame("2026-08-15T10:04:00.000Z"),
    ]);
    const rebound = await writeTranscript(
      context.projects,
      WORKTREE,
      REBOUND_CONVERSATION,
      [assistantFrame("msg_after", "survives a restart", "2026-08-15T10:05:00.000Z")],
    );
    await runClaudeTranscriptRebind({
      sessionId: WORKER_ONE,
      payload: JSON.stringify({
        session_id: REBOUND_CONVERSATION,
        transcript_path: rebound,
        cwd: WORKTREE,
        source: "clear",
      }),
      store: context.bindings,
    });

    // The binding is on disk before any broker is listening, so a restart needs no replay.
    const restarted = context.store();
    await expect(restarted.captureProviderTurns(capture(WORKER_ONE, 2))).resolves.toMatchObject([
      { text: "survives a restart", data: { transport: "provider-native" } },
    ]);
    await expect(restarted.readTranscriptMessages(capture(WORKER_ONE, 2))).resolves.toMatchObject([
      { role: "assistant", text: "survives a restart" },
    ]);
  });

  it("captures nothing when a candidate is ambiguous rather than guessing", async () => {
    const context = await harness();
    const shared = await writeTranscript(
      context.projects,
      WORKTREE,
      CLEARED_CONVERSATION,
      [assistantFrame("msg_shared", "one conversation, two claimants", "2026-08-15T10:05:00.000Z")],
    );
    for (const sessionId of [WORKER_ONE, WORKER_TWO]) {
      await runClaudeTranscriptRebind({
        sessionId,
        payload: JSON.stringify({
          session_id: CLEARED_CONVERSATION,
          transcript_path: shared,
          cwd: WORKTREE,
          source: "clear",
        }),
        store: context.bindings,
      });
    }
    const store = context.store();

    await expect(store.captureProviderTurns(capture(WORKER_ONE, 2))).resolves.toMatchObject([
      { text: "one conversation, two claimants" },
    ]);
    // No capture beats wrong attribution: the second claimant reads nothing native at all.
    await expect(store.captureProviderTurns({ ...capture(WORKER_TWO, 2), allowFallback: false }))
      .resolves.toEqual([]);
    expect(store.claudeTranscriptStatus(WORKER_TWO)).toBe("attribution-conflict");
    await expect(store.readTranscriptMessages(capture(WORKER_TWO, 2))).resolves.toEqual([]);
  });

  it("refuses a binding recorded against a different working directory", async () => {
    const context = await harness();
    const elsewhere = await writeTranscript(
      context.projects,
      "/tmp/other-worktree",
      REBOUND_CONVERSATION,
      [assistantFrame("msg_elsewhere", "wrong worktree", "2026-08-15T10:05:00.000Z")],
    );
    await runClaudeTranscriptRebind({
      sessionId: WORKER_ONE,
      payload: JSON.stringify({
        session_id: REBOUND_CONVERSATION,
        transcript_path: elsewhere,
        cwd: "/tmp/other-worktree",
        source: "clear",
      }),
      store: context.bindings,
    });
    const store = context.store();

    await expect(store.captureProviderTurns({ ...capture(WORKER_ONE, 2), allowFallback: false }))
      .resolves.toEqual([]);
    expect(store.claudeTranscriptStatus(WORKER_ONE)).toBe("foreign-cwd");
  });

  it("reads a quoted /clear marker as conversation, not as a clear", async () => {
    const context = await harness();
    await writeTranscript(context.projects, WORKTREE, WORKER_ONE, [
      quotedClearFrame("2026-08-15T10:00:01.000Z"),
      assistantFrame("msg_still_here", "still the same conversation", "2026-08-15T10:00:02.000Z"),
    ]);
    const store = context.store();

    await expect(store.captureProviderTurns(capture(WORKER_ONE, 1))).resolves.toMatchObject([
      { text: "still the same conversation", data: { transport: "provider-native" } },
    ]);
    expect(store.claudeTranscriptStatus(WORKER_ONE)).toBe("bound");
  });

  it("drops a retired session's binding", async () => {
    const context = await harness();
    await runClaudeTranscriptRebind({
      sessionId: WORKER_ONE,
      payload: JSON.stringify({
        session_id: REBOUND_CONVERSATION,
        transcript_path: join(context.projects, "anything.jsonl"),
        cwd: WORKTREE,
        source: "resume",
      }),
      store: context.bindings,
    });
    await expect(context.bindings.list()).resolves.toHaveLength(1);

    await context.bindings.remove(WORKER_ONE);
    await expect(context.bindings.read(WORKER_ONE)).resolves.toBeUndefined();
    // Removing a session that never bound is not an error.
    await expect(context.bindings.remove(WORKER_TWO)).resolves.toBeUndefined();
  });

  it("ignores an unreadable hook payload without recording a binding", async () => {
    const context = await harness();
    await expect(runClaudeTranscriptRebind({
      sessionId: WORKER_ONE,
      payload: "not json",
      store: context.bindings,
    })).resolves.toEqual({ recorded: false, reason: "unreadable-payload" });
    await expect(runClaudeTranscriptRebind({
      sessionId: WORKER_ONE,
      payload: JSON.stringify({ session_id: REBOUND_CONVERSATION }),
      store: context.bindings,
    })).resolves.toEqual({ recorded: false, reason: "unreadable-payload" });
    await expect(context.bindings.read(WORKER_ONE)).resolves.toBeUndefined();
  });
});

describe("Claude transcript hook settings", () => {
  it("names the Cyberdeck session on the command line, not in the payload", () => {
    const settings = JSON.parse(claudeTranscriptHookSettings({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/cyberdeck/cli.js",
      sessionId: WORKER_ONE,
      stateDirectory: "/state/dir",
    })) as {
      hooks: {
        SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
      };
    };
    const entry = settings.hooks.SessionStart[0]!;
    expect(entry.matcher).toContain("clear");
    expect(entry.hooks[0]!.command).toBe(
      `/usr/bin/node /opt/cyberdeck/cli.js transcript rebind --actor-session ${WORKER_ONE}`
        + " --state-directory /state/dir",
    );
  });
});
