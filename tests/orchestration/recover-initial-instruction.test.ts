import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";
import { codexLaunchFixture } from "../fixtures/codex-launch.js";
import { describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "../../src/domain/session.js";
import { recoverInitialInstruction } from "../../src/orchestration/session/recover-initial-instruction.js";
import type { TranscriptLike } from "../../src/orchestration/session/session-registry-ports.js";

const record = { id: crypto.randomUUID(), initialInstructionId: crypto.randomUUID(), provider: "claude", cwd: "/repo", createdAt: "2026-10-13T10:00:00Z" } as SessionRecord;
const ledger = { completedTurns: 0, canonicalTurns: 0, turns: [] };
const native = { sessionId: record.id, provider: record.provider, turnNumber: 1, turns: [
  { providerTurnId: "native-first", providerOccurredAt: record.createdAt, transport: "provider-native" as const, text: "FIRST_ACK" },
] };
const transcripts = (): TranscriptLike => ({ append: vi.fn(), readCompletionLedger: vi.fn(async () => ledger),
  observeProviderTurns: vi.fn(async () => native), commitProviderTurns: vi.fn(async () => []) });

describe("initial instruction recovery", () => {
  it.each(["explicit", "inherited", "remote"])("requires an own marker on recovery of a %s marker-injected launch", async mode => {
    const h = await codexLaunchFixture();
    try {
      if (mode === "explicit") h.a.providerInstructions = "explicit rules";
      else h.a.launchRecord = { mode: "launch", transport: "pty", resolvedAt: h.a.createdAt, executable: "codex",
        args: mode === "remote" ? ["bridge.js", "--actor-session", h.a.id, "--", "codex"]
          : ["-c", 'developer_instructions="inherited rules\\n\\n[cyberdeck-native-session:' + h.a.id + ']"'],
        cwd: h.root, cyberdeckEnv: {}, inheritedEnvCount: 0, truncated: false };
      await h.metadata("FOREIGN", h.a.createdAt);
      await h.complete("FOREIGN", "A BRIEF");
      const restarted = new ThreadTranscriptStore(h.root, h.options);
      await expect(recoverInitialInstruction(h.a, restarted)).resolves.toMatchObject({ completed: false, unavailable: expect.any(String) });
      expect(await restarted.readCompletionLedger(h.a.id)).toMatchObject({ canonicalTurns: 0, turns: [] });
    } finally { await rm(h.root, { recursive: true, force: true }); }
  });

  it("refuses a two-hour-old markerless rollout with the same brief after restart", async () => {
    const h = await codexLaunchFixture();
    try {
      await h.metadata("FOREIGN", "2026-10-13T08:00:00.000Z");
      await h.complete("FOREIGN", "A BRIEF");
      const restarted = new ThreadTranscriptStore(h.root, h.options);
      await expect(recoverInitialInstruction(h.a, restarted)).resolves.toEqual({
        completed: false,
        unavailable: "Exact native first-turn identity is unavailable; resume or restart to retry without resending the brief",
      });
      expect(await restarted.readCompletionLedger(h.a.id)).toMatchObject({ canonicalTurns: 0, turns: [] });
    } finally { await rm(h.root, { recursive: true, force: true }); }
  });

  it("banks an aborted native launch as cancelled across restart instead of completing its brief", async () => {
    const h = await codexLaunchFixture();
    try {
      await h.metadata("A", h.a.createdAt);
      await appendFile(join(h.root, "sessions", "2026", "10", "13", "A.jsonl"), [
        { type: "event_msg", payload: { type: "user_message", message: "A BRIEF" } },
        { type: "event_msg", timestamp: "2026-10-13T10:00:05.000Z", payload: { type: "turn_aborted", turn_id: "A" } },
      ].map(frame => JSON.stringify(frame)).join("\n") + "\n");
      await expect(recoverInitialInstruction(h.a, h.store)).resolves.toEqual({ completed: false, cancelled: true });
      const restarted = new ThreadTranscriptStore(h.root, h.options);
      await expect(recoverInitialInstruction(h.a, restarted)).resolves.toEqual({ completed: false, cancelled: true });
      expect(await restarted.readCompletionLedger(h.a.id)).toMatchObject({ canonicalTurns: 1,
        turns: [{ data: { turnNumber: 1, outcome: "cancelled", transport: "provider-native" } }] });
    } finally { await rm(h.root, { recursive: true, force: true }); }
  });

  it("propagates broker ledger failures rather than disguising them as unavailable native evidence", async () => {
    const source = transcripts();
    vi.mocked(source.readCompletionLedger!).mockRejectedValue(new Error("broker ledger unreadable"));
    await expect(recoverInitialInstruction(record, source)).rejects.toThrow("broker ledger unreadable");
    expect(source.observeProviderTurns).not.toHaveBeenCalled();
  });
  it("propagates broker commit failures rather than losing an authoritative native receipt", async () => {
    const source = transcripts();
    vi.mocked(source.commitProviderTurns!).mockRejectedValue(new Error("broker journal full"));
    await expect(recoverInitialInstruction(record, source)).rejects.toThrow("broker journal full");
  });
  it("never promotes terminal replay into first-brief consumption during recovery", async () => {
    const source = transcripts();
    vi.mocked(source.observeProviderTurns!).mockResolvedValue({ ...native, turns: native.turns.map((turn) => ({ ...turn, transport: "terminal-replay-fallback" })) });
    await expect(recoverInitialInstruction(record, source)).resolves.toEqual({ completed: false });
    expect(source.commitProviderTurns).not.toHaveBeenCalled();
  });
});

  it("recovers two same-cwd Codex launches only from their own exact first prompt", async () => {
    const h = await codexLaunchFixture();
    try {
      await h.metadata("B", h.a.createdAt); // B is the only, nearest heuristic candidate for A.
      await h.complete("B", "B BRIEF");
      const restarted = new ThreadTranscriptStore(h.root, h.options);
      await expect(recoverInitialInstruction(h.a, restarted)).resolves.toMatchObject({ completed: false, unavailable: expect.any(String) });
      expect((await restarted.readCompletionLedger(h.a.id)).canonicalTurns).toBe(0);
      await expect(recoverInitialInstruction(h.b, restarted)).resolves.toEqual({ completed: true });
      await h.metadata("A", h.a.createdAt);
      await h.complete("A", "A BRIEF");
      await expect(recoverInitialInstruction(h.a, restarted)).resolves.toEqual({ completed: true });
      for (const [record, answer] of [[h.a, "A ANSWER"], [h.b, "B ANSWER"]] as const) {
        expect(await restarted.readCompletionLedger(record.id)).toMatchObject({ canonicalTurns: 1, turns: [{ text: answer }] });
      }
    } finally { await rm(h.root, { recursive: true, force: true }); }
  });
