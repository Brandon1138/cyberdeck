import { describe, expect, it, vi } from "vitest";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import { InstructionRecordSchema, type InstructionRecord } from "../../src/domain/instruction.js";
import type { SessionInstructionPort } from "../../src/orchestration/session/session-ports.js";
import { fleetMethods } from "../../src/broker/server/fleet-methods.js";
import { agentMethods } from "../../src/broker/server/agent-methods.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InstructionStore } from "../../src/persistence/instruction-store.js";

const targetSessionId = crypto.randomUUID();
const instructionId = crypto.randomUUID();
const messageId = crypto.randomUUID();
const request = { targetSessionId, instructionId, messageId, reason: "Retire expired RC20 preparation",
  authority: { path: "/private/tmp/operator-mandate.json", sha256: "a".repeat(64) } };

function fixture(status: InstructionRecord["status"]) {
  let value: InstructionRecord = { id: instructionId, actorSessionId: crypto.randomUUID(), targetSessionId,
    messageId, message: "expired preparation", status, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), hop: 0 };
  const put = vi.fn(async (record: InstructionRecord) => { value = InstructionRecordSchema.parse(record); });
  const sessions = { onControllerReleased: () => () => {}, onDeliveryBoundary: () => () => {},
    onInstructionState: () => () => {}, get: vi.fn(), submitInstruction: vi.fn() } satisfies SessionInstructionPort;
  const queue = new InstructionQueue(sessions, { findBySessionId: vi.fn() }, {
    list: async (target) => target === undefined || target === targetSessionId ? [value] : [], put,
  });
  return { queue, put, sessions, value: () => value };
}

describe("operator exact instruction withdrawal", () => {
  it.each(["accepted", "queued"] as const)("durably cancels %s with provenance and cannot flush it later", async (status) => {
    const f = fixture(status);
    const result = await f.queue.withdrawForOperator(request);
    expect(result).toMatchObject({ outcome: "CANCELLED", instruction: { status: "cancelled", withdrawal: {
      kind: "operator", reason: request.reason, authority: request.authority,
    } } });
    expect(InstructionRecordSchema.parse(f.value()).withdrawal).toEqual(f.value().withdrawal);
    const persisted = f.value();
    await f.queue.flush(targetSessionId);
    expect(f.sessions.submitInstruction).not.toHaveBeenCalled();
    expect(await f.queue.withdrawForOperator(request)).toEqual({ outcome: "CANCELLED", instruction: persisted });
    expect(f.put).toHaveBeenCalledTimes(1);
  });

  it.each(["rendered", "submitted", "acknowledged", "completed", "undelivered"] as const)("does not claim cancellation of %s", async (status) => {
    const f = fixture(status);
    expect(await f.queue.withdrawForOperator(request)).toMatchObject({ outcome: "TOO_LATE", instruction: { status } });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("requires all three exact identities without mutating a replacement", async () => {
    const f = fixture("queued");
    expect(await f.queue.withdrawForOperator({ ...request, messageId: crypto.randomUUID() })).toEqual({ outcome: "IDENTITY_MISMATCH" });
    expect(await f.queue.withdrawForOperator({ ...request, instructionId: crypto.randomUUID() })).toEqual({ outcome: "NOT_FOUND" });
    expect(await f.queue.withdrawForOperator({ ...request, targetSessionId: crypto.randomUUID() })).toEqual({ outcome: "NOT_FOUND" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("serializes withdrawal against delivery that has already rendered", async () => {
    const f = fixture("queued");
    // An in-flight provider write advances under the same per-target serializer before withdrawal.
    let release!: () => void;
    let entered!: () => void;
    const enteredDelivery = new Promise<void>((resolve) => { entered = resolve; });
    const delivery = (f.queue as unknown as { serialize<T>(id: string, work: () => Promise<T>): Promise<T> })
      .serialize(targetSessionId, async () => {
        await new Promise<void>((resolve) => { release = resolve; entered(); });
        await f.put({ ...f.value(), status: "rendered", renderedAt: new Date().toISOString(), expectedTurn: 13 });
      });
    await enteredDelivery;
    const withdrawal = f.queue.withdrawForOperator(request);
    release();
    await delivery;
    expect(await withdrawal).toMatchObject({ outcome: "TOO_LATE", instruction: { status: "rendered", expectedTurn: 13 } });
    expect(f.value().withdrawal).toBeUndefined();
  });

  it("exposes the operation only on the operator surface", () => {
    expect(fleetMethods["fleet.instruction.withdraw"]).toBeTypeOf("function");
    expect(Object.keys(agentMethods).some((name) => /withdraw/.test(name))).toBe(false);
  });

  it("retains the terminal operator receipt and provenance after store restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rc20-withdrawal-test-"));
    try {
      const f = fixture("queued");
      const store = new InstructionStore(directory);
      await store.put(f.value());
      const queue = new InstructionQueue(f.sessions, { findBySessionId: vi.fn() }, store);
      const result = await queue.withdrawForOperator(request);
      const restored = (await new InstructionStore(directory).list(targetSessionId))[0];
      expect(restored).toEqual(result.instruction);
      expect(restored).toMatchObject({ status: "cancelled", withdrawal: { authority: request.authority, reason: request.reason } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
