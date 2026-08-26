import { describe, expect, it, vi } from "vitest";
import { InstructionQueue } from "../../src/orchestration/instruction-queue.js";
import type { InstructionRecord } from "../../src/domain/instruction.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";
import type {
  InstructionRepository,
  OrchestratorBindingReader,
  SessionInstructionPort,
} from "../../src/orchestration/session/session-ports.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const binding: OrchestratorBinding = {
  key: "workspace:/repo",
  kind: "primary",
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
    const sessions = {
      get: vi.fn(),
      onControllerReleased: vi.fn((listener: (sessionId: string) => void) => {
        available = listener;
        return () => { available = undefined; };
      }),
      onDeliveryBoundary: vi.fn(() => () => undefined),
      onInstructionState: vi.fn(() => () => undefined),
      submitInstruction: vi.fn(),
    } satisfies SessionInstructionPort;
    sessions.get.mockReturnValue({ id: TARGET, cwd: "/repo" } as SessionRecord);
    sessions.submitInstruction.mockImplementation(async () => {
      if (busy) throw Object.assign(new Error("busy"), { code: "SESSION_BUSY" });
      return { state: "rendered", expectedTurn: 1, at: new Date().toISOString() };
    });
    const queue = new InstructionQueue(
      sessions,
      { findBySessionId: vi.fn(async () => binding) } satisfies OrchestratorBindingReader,
      {
        put: vi.fn(async (record: InstructionRecord) => { records.set(record.id, record); }),
        list: vi.fn(async (target?: string) => [...records.values()].filter((record) => target === undefined || record.targetSessionId === target)),
      } satisfies InstructionRepository,
    );
    queue.start();

    const queued = await queue.enqueue({ actorSessionId: ACTOR, targetSessionId: TARGET, message: "Summarize" });
    expect(queued.status).toBe("queued");
    expect(queued.holdReason).toBe("human-controller");
    busy = false;
    available?.(TARGET);
    // `rendered`, not `delivered`: the queue may only report what the broker actually observed.
    await vi.waitFor(async () => expect((await queue.list(TARGET))[0]?.status).toBe("rendered"));
    expect(sessions.submitInstruction).toHaveBeenCalledTimes(2);
  });

  it("deduplicates retries by message id", async () => {
    const messageId = crypto.randomUUID();
    const existing = { id: crypto.randomUUID(), messageId, status: "rendered" } as InstructionRecord;
    const sessions = {
      get: vi.fn(() => ({ id: TARGET, cwd: "/repo" } as SessionRecord)),
      onControllerReleased: vi.fn(() => () => undefined),
      onDeliveryBoundary: vi.fn(() => () => undefined),
      onInstructionState: vi.fn(() => () => undefined),
      submitInstruction: vi.fn(),
    } satisfies SessionInstructionPort;
    const queue = new InstructionQueue(
      sessions,
      { findBySessionId: vi.fn(async () => binding) } satisfies OrchestratorBindingReader,
      {
        list: vi.fn(async () => [existing]),
        put: vi.fn(),
      } satisfies InstructionRepository,
    );
    await expect(queue.enqueue({ actorSessionId: ACTOR, targetSessionId: TARGET, message: "Again", messageId }))
      .resolves.toBe(existing);
  });

  it("delivers broker-owned policy instructions through the same durable queue", async () => {
    const records = new Map<string, InstructionRecord>();
    const sessions = {
      get: vi.fn(() => ({ id: TARGET, cwd: "/repo" } as SessionRecord)),
      onControllerReleased: vi.fn(() => () => undefined),
      onDeliveryBoundary: vi.fn(() => () => undefined),
      onInstructionState: vi.fn(() => () => undefined),
      submitInstruction: vi.fn(async () => ({
        state: "rendered" as const,
        expectedTurn: 1,
        at: new Date().toISOString(),
      })),
    } satisfies SessionInstructionPort;
    const queue = new InstructionQueue(
      sessions,
      { findBySessionId: vi.fn(async () => undefined) } satisfies OrchestratorBindingReader,
      {
        put: vi.fn(async (record: InstructionRecord) => { records.set(record.id, record); }),
        list: vi.fn(async (target?: string) => [...records.values()].filter(
          (record) => target === undefined || record.targetSessionId === target,
        )),
      } satisfies InstructionRepository,
    );
    const messageId = crypto.randomUUID();

    const first = await queue.enqueueBroker({
      actorSessionId: ACTOR,
      targetSessionId: TARGET,
      message: "Wrap up and summarize before budget exhaustion.",
      messageId,
    });
    const replay = await queue.enqueueBroker({
      actorSessionId: ACTOR,
      targetSessionId: TARGET,
      message: "Wrap up and summarize before budget exhaustion.",
      messageId,
    });

    expect(first).toMatchObject({ status: "rendered", brokerOwned: true });
    expect(replay.id).toBe(first.id);
    expect(sessions.submitInstruction).toHaveBeenCalledOnce();
    expect(sessions.submitInstruction).toHaveBeenCalledWith(
      TARGET,
      "Wrap up and summarize before budget exhaustion.",
      "broker",
      expect.objectContaining({ brokerOwned: true }),
      first.id,
    );
  });

  it("persists instructions as undelivered after broker hard-budget refusal", async () => {
    const records = new Map<string, InstructionRecord>();
    const sessions = {
      get: vi.fn(() => ({ id: TARGET, cwd: "/repo" } as SessionRecord)),
      onControllerReleased: vi.fn(() => () => undefined),
      onDeliveryBoundary: vi.fn(() => () => undefined),
      onInstructionState: vi.fn(() => () => undefined),
      submitInstruction: vi.fn(async () => {
        throw Object.assign(new Error("hard budget reached"), {
          code: "WORKER_BUDGET_EXHAUSTED",
        });
      }),
    } satisfies SessionInstructionPort;
    const queue = new InstructionQueue(
      sessions,
      { findBySessionId: vi.fn(async () => binding) } satisfies OrchestratorBindingReader,
      {
        put: vi.fn(async (record: InstructionRecord) => { records.set(record.id, record); }),
        list: vi.fn(async (target?: string) => [...records.values()].filter(
          (record) => target === undefined || record.targetSessionId === target,
        )),
      } satisfies InstructionRepository,
    );

    await expect(queue.enqueue({
      actorSessionId: ACTOR,
      targetSessionId: TARGET,
      message: "Continue work",
    })).resolves.toMatchObject({
      status: "undelivered",
      holdReason: "worker-budget-exhausted",
    });
  });
});
