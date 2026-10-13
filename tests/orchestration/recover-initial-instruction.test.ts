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
