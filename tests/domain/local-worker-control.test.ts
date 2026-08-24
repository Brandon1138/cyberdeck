import { describe, expect, it } from "vitest";
import {
  LocalWorkerCommandSchema,
  LocalWorkerSnapshotRequestSchema,
  LocalWorkerSubscribeRequestSchema,
  LocalWorkerTelemetrySnapshotSchema,
  LocalWorkerUnsubscribeRequestSchema,
  LocalWorkerUnsubscribeResultSchema,
} from "../../src/domain/local-worker-control.js";
import { LocalWorkerTelemetryFrameSchema, ServerFrameSchema } from "../../src/protocol/frames.js";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222222";

function snapshot() {
  return {
    schemaVersion: 1 as const,
    cursor: 7,
    generatedAt: "2026-08-24T10:02:00.000Z",
    workers: [{
      schemaVersion: 1 as const,
      sessionId: WORKER_ID,
      parent: { sessionId: PARENT_ID, kind: "orchestrator" as const },
      provider: "codex",
      role: "worker",
      model: {
        value: "gpt-5.6-sol",
        effort: "high",
        provenance: "observed" as const,
        observedAt: "2026-08-24T10:01:00.000Z",
      },
      taskSummary: "Inspect local telemetry",
      lifecycle: {
        state: "working" as const,
        terminal: false,
        executionState: "active" as const,
        detail: "Provider turn in flight",
        startedAt: "2026-08-24T10:00:00.000Z",
        endedAt: null,
        elapsedMs: 120_000,
      },
      budget: {
        revision: 2,
        resource: "weekly" as const,
        unit: "percent" as const,
        allocatedAmount: 20,
        consumedAmount: null,
        remainingAmount: null,
        measurement: {
          source: "unavailable" as const,
          accuracy: "unknown" as const,
          observedAt: null,
          freshness: "unknown" as const,
          reason: "No compatible broker measurement has been observed",
        },
        providerRemaining: {
          amount: null,
          unit: null,
          observedAt: null,
          freshness: "unknown" as const,
          accuracy: "unknown" as const,
          reason: "Provider-wide remaining usage is unavailable",
        },
        policy: {
          softLimit: { thresholdAmount: 16, action: "wrap-up" as const, triggeredAt: null },
          hardLimit: { thresholdAmount: 20, action: "stop" as const, triggeredAt: null },
        },
        enforcement: {
          state: "active" as const,
          revision: null,
          reachedAt: null,
          actionAt: null,
        },
      },
      commands: {
        inspect: true as const,
        stop: true,
        extendBudget: true,
        reduceBudget: true,
        pause: false as const,
        resume: false as const,
        open: false as const,
      },
    }],
  };
}

describe("local worker control v1 contracts", () => {
  it("keeps unknown consumption and provider allowance explicit rather than fabricating zero", () => {
    const parsed = LocalWorkerTelemetrySnapshotSchema.parse(snapshot());
    expect(parsed.workers[0]?.budget).toMatchObject({
      consumedAmount: null,
      remainingAmount: null,
      providerRemaining: {
        amount: null,
        freshness: "unknown",
        accuracy: "unknown",
      },
    });
  });

  it("accepts stop and revision-guarded budget adjustments only", () => {
    expect(LocalWorkerCommandSchema.parse({
      schemaVersion: 1,
      action: "stop",
      workerId: WORKER_ID,
      reason: "operator requested stop",
      mutationId: "local:stop:1",
    })).not.toHaveProperty("expectedRevision");

    expect(LocalWorkerCommandSchema.parse({
      schemaVersion: 1,
      action: "extend-budget",
      workerId: WORKER_ID,
      reason: "allow final verification",
      mutationId: "local:extend:1",
      expectedRevision: 2,
      amount: 5,
    })).toMatchObject({ action: "extend-budget", expectedRevision: 2, amount: 5 });

    expect(LocalWorkerCommandSchema.safeParse({
      schemaVersion: 1,
      action: "pause",
      workerId: WORKER_ID,
      reason: "pause",
      mutationId: "local:pause:1",
    }).success).toBe(false);
  });

  it("uses strict versioned snapshot and subscription requests", () => {
    expect(LocalWorkerSnapshotRequestSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
    expect(LocalWorkerSubscribeRequestSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
    expect(LocalWorkerUnsubscribeRequestSchema.parse({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
    expect(LocalWorkerUnsubscribeResultSchema.parse({ schemaVersion: 1, subscribed: false })).toEqual({
      schemaVersion: 1,
      subscribed: false,
    });
    expect(LocalWorkerSnapshotRequestSchema.safeParse({ schemaVersion: 1, includeProcesses: true }).success)
      .toBe(false);
  });

  it("rejects unknown fields and unsupported schema versions", () => {
    expect(LocalWorkerCommandSchema.safeParse({
      schemaVersion: 1,
      action: "reduce-budget",
      workerId: WORKER_ID,
      reason: "tighten allocation",
      mutationId: "local:reduce:1",
      expectedRevision: 2,
      amount: 1,
      bypassHardLimit: true,
    }).success).toBe(false);
    expect(LocalWorkerCommandSchema.safeParse({
      schemaVersion: 2,
      action: "stop",
      workerId: WORKER_ID,
      reason: "stop",
      mutationId: "local:stop:2",
    }).success).toBe(false);
  });

  it("carries a full v1 snapshot in the dedicated server frame", () => {
    const frame = { type: "local-worker-telemetry" as const, snapshot: snapshot() };
    expect(LocalWorkerTelemetryFrameSchema.parse(frame)).toEqual(frame);
    expect(ServerFrameSchema.parse(frame)).toEqual(frame);
  });
});
