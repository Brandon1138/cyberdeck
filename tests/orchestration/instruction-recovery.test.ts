import { describe, expect, it, vi } from "vitest";
import { recoverPendingInstructions } from "../../src/orchestration/instruction-recovery.js";
import type { InstructionRecord } from "../../src/domain/instruction.js";

const record: InstructionRecord = { id: "instruction", messageId: "message", actorSessionId: "actor", targetSessionId: "worker",
  message: "follow-up", status: "rendered", expectedTurn: 2, hop: 0, createdAt: "2026-11-14T12:00:00.000Z", updatedAt: "2026-11-14T12:00:00.000Z" };

describe("instruction recovery attribution", () => {
  it.each(["missing-target", "missing-receipt", "different-ordinal"])("does not complete from high-water counts with %s", async missing => {
    const apply = vi.fn(), flush = vi.fn();
    await recoverPendingInstructions([record], async () => ({ completedTurns: 10, canonicalTurns: 10,
      instructionTargets: missing === "missing-target" ? [] : [{ instructionId: record.id,
        expectedTurn: missing === "different-ordinal" ? 3 : 2, renderedAt: record.createdAt }],
      turns: missing === "missing-receipt" ? [] : [{ text: "older answer", data: { turnNumber: 2 } }],
    }), apply, flush);
    expect(apply).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledExactlyOnceWith("worker");
  });

  it("fails startup explicitly on an unreadable recovery ledger without writing input", async () => {
    const flush = vi.fn();
    await expect(recoverPendingInstructions([record], async () => { throw new Error("completion ledger unreadable"); },
      vi.fn(), flush)).rejects.toThrow("completion ledger unreadable");
    expect(flush).not.toHaveBeenCalled();
  });
});
