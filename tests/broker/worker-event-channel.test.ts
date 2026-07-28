import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WorkerEventChannel } from "../../src/broker/worker-event-channel.js";
import { WorkerCoordinationService } from "../../src/broker/worker-coordination.js";
import { createProgram } from "../../src/cli.js";
import type { OrchestratorBinding } from "../../src/domain/orchestrator.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { WorkerControlService } from "../../src/orchestration/worker-control-service.js";
import { WorkerCoordinationStore } from "../../src/persistence/worker-coordination-store.js";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const ORC_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-07-27T12:00:00.000Z";

function worker(): SessionRecord {
  return {
    id: WORKER_ID,
    provider: "codex",
    cwd: "/tmp/repo",
    detached: true,
    sandbox: "workspace-write",
    parentSessionId: ORC_ID,
    kind: "worker",
    createdAt: NOW,
    updatedAt: NOW,
    executionState: "active",
    attachmentState: "detached",
    attentionState: "working",
    pid: 123,
    exitCode: null,
    childIds: [],
  };
}

function binding(): OrchestratorBinding {
  return {
    key: "fleet",
    sessionId: ORC_ID,
    provider: "codex",
    cwd: "/tmp/repo",
    sandbox: "read-only",
    scope: { kind: "fleet" },
    grant: {
      subjectSessionId: ORC_ID,
      capabilities: ["thread.enqueue", "worker.start"],
      scope: { kind: "fleet" },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function credentialCustodian() {
  const entries = new Map<string, { leaseToken: string; leaseVersion: number }>();
  const key = (controllerId: string, workerId: string) => `${controllerId}\0${workerId}`;
  return {
    get: (controllerId: string, workerId: string) => entries.get(key(controllerId, workerId)),
    set: (
      controllerId: string,
      workerId: string,
      credential: { leaseToken: string; leaseVersion: number },
    ) => entries.set(key(controllerId, workerId), credential),
    delete: (controllerId: string, workerId: string) => entries.delete(key(controllerId, workerId)),
  };
}

async function harness(options: {
  directory?: string;
  now?: () => string;
  credentials?: ReturnType<typeof credentialCustodian>;
} = {}) {
  const directory = options.directory
    ?? await mkdtemp(join(tmpdir(), "cyberdeck-worker-event-channel-"));
  const currentTime = options.now ?? (() => NOW);
  const coordination = new WorkerCoordinationService({
    store: new WorkerCoordinationStore(directory),
    now: currentTime,
    leaseDurationMs: 60_000,
  });
  await coordination.initialize();
  const enqueue = vi.fn(async (input) => ({
    id: crypto.randomUUID(),
    actorSessionId: input.actorSessionId,
    targetSessionId: input.targetSessionId,
    message: input.message,
    status: "delivered" as const,
    createdAt: NOW,
    updatedAt: NOW,
    deliveredAt: NOW,
    messageId: input.messageId ?? crypto.randomUUID(),
    hop: 0,
  }));
  const channel = new WorkerEventChannel(
    coordination,
    { get: () => worker() },
    { findBySessionId: async (sessionId) => sessionId === ORC_ID ? binding() : undefined },
    { enqueue },
    currentTime,
    options.credentials,
  );
  const control = new WorkerControlService({
    coordination,
    registry: {
      get: () => worker(),
      ownsProcess: () => true,
      isStopRequested: () => false,
      stopRequestedAt: () => undefined,
      onSessionUpdate: () => () => undefined,
      stop: async () => undefined,
      forceStop: () => undefined,
    } as never,
    orchestrators: {
      findBySessionId: async (sessionId: string) => sessionId === ORC_ID ? binding() : undefined,
    } as never,
    instructions: { enqueue } as never,
    now: () => Date.parse(currentTime()),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
  return { directory, coordination, channel, control, enqueue };
}

describe("WorkerEventChannel", () => {
  it("submits idempotently and returns duplicate or superseded compact acks", async () => {
    const { channel, coordination } = await harness();
    const first = {
      workerId: WORKER_ID,
      eventId: "progress-1",
      kind: "PROGRESS" as const,
      summary: "first",
    };
    await expect(channel.submit(first)).resolves.toMatchObject({
      code: "accepted",
      eventId: "progress-1",
      sequence: 1,
    });
    await expect(channel.submit(first)).resolves.toMatchObject({
      code: "duplicate",
      eventId: "progress-1",
      sequence: 1,
    });
    await expect(channel.submit({ ...first, summary: "collision" })).resolves.toMatchObject({
      code: "rejected",
      errorCode: "EVENT_ID_COLLISION",
    });
    await expect(channel.submit({
      ...first,
      eventId: "progress-2",
      summary: "second",
    })).resolves.toMatchObject({
      code: "accepted",
      supersededEventIds: ["progress-1"],
    });
    expect(coordination.projectEvents().events.map(({ eventId }) => eventId)).toEqual(["progress-2"]);
  });

  it("rejects payload-cap violations with exact limit and never truncates", async () => {
    const { channel } = await harness();
    await expect(channel.submit({
      workerId: WORKER_ID,
      eventId: "oversized",
      kind: "EXCEPTION",
      summary: "x".repeat(17_000),
      severity: "error",
      continuation: "blocked",
    })).resolves.toMatchObject({
      code: "rejected",
      errorCode: "PAYLOAD_LIMIT_EXCEEDED",
      message: expect.stringContaining("limit is 16384 bytes"),
    });
  });

  it("delivers checkpoint correlation through queued input and accepts response", async () => {
    const { channel, coordination, enqueue } = await harness();
    const checkpoint = await channel.requestCheckpoint({
      actorSessionId: ORC_ID,
      workerId: WORKER_ID,
      correlationId: "checkpoint-7",
      focus: "test failures",
    });
    expect(checkpoint).toMatchObject({
      correlationId: "checkpoint-7",
      mode: "non-blocking",
      state: "pending",
    });
    expect(coordination.getSubject(WORKER_ID)).toMatchObject({
      lifecycle: "working",
      decisionGate: { state: "none" },
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      actorSessionId: ORC_ID,
      targetSessionId: WORKER_ID,
      message: expect.stringContaining("checkpoint-7"),
    }));

    await expect(channel.submit({
      workerId: WORKER_ID,
      eventId: "checkpoint-response-7",
      kind: "CHECKPOINT",
      summary: "tests now pass",
      checkpointCorrelationId: "checkpoint-7",
    })).resolves.toMatchObject({ code: "accepted" });
    expect(coordination.listCheckpoints(WORKER_ID)[0]).toMatchObject({
      state: "answered",
      answeredByEventId: "checkpoint-response-7",
    });
  });

  it("uses structured awaiting-response state for decision requests", async () => {
    const { channel, coordination } = await harness();
    await expect(channel.submit({
      workerId: WORKER_ID,
      eventId: "decision-invalid",
      kind: "DECISION_REQUEST",
      summary: "choose API",
    })).resolves.toMatchObject({ code: "rejected", errorCode: "INVALID_EVENT" });
    await expect(channel.submit({
      workerId: WORKER_ID,
      eventId: "decision-valid",
      kind: "DECISION_REQUEST",
      summary: "choose API",
      severity: "warning",
      interventionRequired: true,
      continuation: "awaiting-response",
    })).resolves.toMatchObject({ code: "accepted" });
    expect(coordination.projectEvents().events[0]).toMatchObject({
      kind: "DECISION_REQUEST",
      interventionRequired: true,
      continuation: "awaiting-response",
    });
  });

  it("keeps event idempotency after store restart", async () => {
    const first = await harness();
    const input = {
      workerId: WORKER_ID,
      eventId: "durable-event",
      kind: "RISK" as const,
      summary: "disk nearly full",
      severity: "warning" as const,
    };
    await first.channel.submit(input);
    const restarted = await harness({ directory: first.directory });
    await expect(restarted.channel.submit(input)).rejects.toMatchObject({
      code: "OWNERSHIP_LOST",
    });
  });

  it("shares one stable lease token across reporting retries and control calls", async () => {
    const credentials = credentialCustodian();
    const state = await harness({ credentials });
    const report = {
      workerId: WORKER_ID,
      eventId: "stable-report",
      kind: "PROGRESS" as const,
      summary: "working",
    };

    await expect(state.channel.submit(report)).resolves.toMatchObject({ code: "accepted" });
    const initialLease = state.coordination.getSubject(WORKER_ID)!.lease;

    await expect(state.control.lease({
      actorSessionId: ORC_ID,
      action: "renew",
      scope: "worker",
      workerId: WORKER_ID,
      reason: "continue control after first report",
    })).resolves.toMatchObject({ results: [{ code: "ALREADY_CONTROLLED" }] });
    await expect(state.channel.submit(report)).resolves.toMatchObject({ code: "duplicate" });
    await expect(state.control.control({
      actorSessionId: ORC_ID,
      action: "request_checkpoint",
      workerId: WORKER_ID,
      reason: "verify control credential remains valid",
      correlationId: "stable-token-checkpoint",
    })).resolves.toMatchObject({ code: "CHECKPOINT_REQUESTED" });

    expect(state.coordination.getSubject(WORKER_ID)!.lease).toMatchObject({
      version: initialLease.version,
      tokenHash: initialLease.tokenHash,
    });
  });

  it("does not reacquire an expired reporting lease", async () => {
    let now = NOW;
    const credentials = credentialCustodian();
    const state = await harness({ now: () => now, credentials });
    await state.channel.submit({
      workerId: WORKER_ID,
      eventId: "before-expiry",
      kind: "PROGRESS",
      summary: "working",
    });
    now = "2026-07-27T12:02:00.000Z";
    await expect(state.channel.submit({
      workerId: WORKER_ID,
      eventId: "after-expiry",
      kind: "PROGRESS",
      summary: "still working",
    })).rejects.toMatchObject({ code: "OWNERSHIP_LOST" });
  });

  it("runs CLI parsing end-to-end against real coordination store", async () => {
    const { channel, coordination } = await harness();
    const output: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await createProgram({
        submitWorkerEvent: (request) => channel.submit(request),
      }).parseAsync([
        "event",
        "submit",
        "--worker",
        WORKER_ID,
        "--kind",
        "PROGRESS",
        "--summary",
        "12 tests pass",
        "--facts",
        "{\"tests\":12}",
        "--evidence",
        "test:unit",
        "--event-id",
        "cli-e2e",
      ], { from: "user" });
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(output.join(""))).toMatchObject({
      code: "accepted",
      eventId: "cli-e2e",
      sequence: 1,
    });
    expect(coordination.projectEvents().events[0]).toMatchObject({
      structuredFacts: { tests: 12 },
      evidenceRefs: ["test:unit"],
    });
  });
});
