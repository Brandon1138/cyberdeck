import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { CodexConversationBindingStore } from "../../src/persistence/codex-conversation-bindings.js";
import { CodexRemoteBootstrap } from "../../src/providers/codex/remote-bootstrap.js";
import { readCodexRemoteIdle } from "../../src/providers/codex/remote-thread-readiness.js";
vi.mock("../../src/providers/codex/remote-thread-readiness.js", () => ({ readCodexRemoteIdle: vi.fn() }));
const roots: string[] = [], actor = "11111111-1111-4111-8111-111111111111";
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp("/tmp/cd-bootstrap-store-"); roots.push(root);
  const now = new Date().toISOString(), sessions = join(root, "sessions"), day = join(sessions, ...now.slice(0, 10).split("-"));
  await mkdir(day, { recursive: true });
  await writeFile(join(day, "unrelated.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "unknown", cwd: "/work", timestamp: now } }) + "\n");
  const bindings = new CodexConversationBindingStore(root);
  const store = new ThreadTranscriptStore(root, { codexSessionsDirectory: sessions, codexRemoteHome: root, codexConversations: bindings });
  const bridge = new CodexRemoteBootstrap(root, actor);
  await bridge.outgoing(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: "/work" } }));
  await bridge.incoming(JSON.stringify({ id: 1, result: { thread: { id: "own", cwd: "/work", turns: [] } } }));
  vi.mocked(readCodexRemoteIdle).mockResolvedValue(true);
  const input = { sessionId: actor, provider: "codex", cwd: "/work", createdAt: now, turnNumber: 1,
    codexMarkerRequired: true, allowCodexBootstrap: true, allowFallback: true, fallbackText: "NEVER COMMIT" };
  return { root, store, bridge, input, bindings };
}
describe("first prompt without a native rollout", () => {
  it("reports separate exact readiness without binding foreign history, fallback, or completion", async () => {
    const f = await fixture(); const observation = await f.store.observeProviderTurns(f.input);
    expect(observation).toMatchObject({ nativeSourceAvailable: false, nativeSourceStatus: "unbound",
      nativeBootstrap: { nativeSessionId: "own" }, nativeFallbackAllowed: false, turns: [] });
    expect(await f.bindings.read(actor)).toBeUndefined();
    expect(await f.store.captureProviderTurns(f.input)).toEqual([]);
    expect(await f.store.readCompletionLedger(actor)).toMatchObject({ completedTurns: 0, canonicalTurns: 0 });
  });
  it.each(["revoked", "no-gate", "later-turn", "initial-prompt", "bound-missing", "daemon-busy", "race"])("refuses bootstrap on %s", async kind => {
    const f = await fixture();
    if (kind === "revoked") await f.bridge.revoke();
    if (kind === "no-gate") f.input.allowCodexBootstrap = false;
    if (kind === "later-turn") f.input.turnNumber = 2;
    if (kind === "initial-prompt") await f.store.append({ sessionId: actor, kind: "prompt", source: "broker", text: "previous",
      data: { initial: true, instructionId: "initial" } });
    if (kind === "bound-missing") await f.bindings.record({ sessionId: actor, nativeSessionId: "old", cwd: "/work", transcriptPath: join(f.root, "missing") });
    if (kind === "daemon-busy") vi.mocked(readCodexRemoteIdle).mockResolvedValue(false);
    if (kind === "race") vi.mocked(readCodexRemoteIdle).mockImplementation(async () => { await f.bridge.revoke(); return true; });
    expect((await f.store.observeProviderTurns(f.input)).nativeBootstrap).toBeUndefined();
  });
});
