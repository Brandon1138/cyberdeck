import { describe, expect, it, vi } from "vitest";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import type { InstructionRecord } from "../../src/domain/instruction.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const binding: OrchestratorBinding = {
  key: "workspace:/repo",
  sessionId: ACTOR,
  provider: "codex",
  cwd: "/repo",
  sandbox: "read-only",
  scope: { kind: "workspace", cwd: "/repo" },
  grant: {
    subjectSessionId: ACTOR,
    capabilities: ["thread.enqueue"],
    scope: { kind: "workspace", cwd: "/repo" },
  },
  createdAt: "2026-07-22T12:00:00.000Z",
  updatedAt: "2026-07-22T12:00:00.000Z",
};

describe("InstructionQueue", () => {
  it("keeps input queued while a human owns the worker and delivers it after release", async () => {
    let available: ((sessionId: string) => void) | undefined;
    let busy = true;
    const records = new Map<string, InstructionRecord>();
    const submitInstruction = vi.fn(async () => {
      if (busy) throw Object.assign(new Error("busy"), { code: "SESSION_BUSY" });
    });
    const queue = new InstructionQueue(
      {
        get: () => ({ id: TARGET, cwd: "/repo" }),
        submitInstruction,
        onControllerReleased: (listener: (sessionId: string) => void) => {
          available = listener;
          return () => { available = undefined; };
        },
      } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      {
        put: vi.fn(async (record: InstructionRecord) => { records.set(record.id, record); }),
        list: vi.fn(async (target?: string) => [...records.values()].filter((record) => target === undefined || record.targetSessionId === target)),
      } as never,
    );
    queue.start();

    const queued = await queue.enqueue({ actorSessionId: ACTOR, targetSessionId: TARGET, message: "Summarize" });
    expect(queued.status).toBe("queued");
    busy = false;
    available?.(TARGET);
    await vi.waitFor(async () => expect((await queue.list(TARGET))[0]?.status).toBe("delivered"));
    expect(submitInstruction).toHaveBeenCalledTimes(2);
  });

  it("deduplicates retries by message id", async () => {
    const messageId = crypto.randomUUID();
    const existing = { id: crypto.randomUUID(), messageId, status: "delivered" } as InstructionRecord;
    const queue = new InstructionQueue(
      { get: () => ({ cwd: "/repo" }) } as never,
      { findBySessionId: vi.fn(async () => binding) } as never,
      { list: vi.fn(async () => [existing]) } as never,
    );
    await expect(queue.enqueue({ actorSessionId: ACTOR, targetSessionId: TARGET, message: "Again", messageId }))
      .resolves.toBe(existing);
  });
});

