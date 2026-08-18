import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HANDOFF_LIMITS,
  WorkerHandoffSchema,
  handoffBriefing,
  type WorkerHandoff,
} from "../../src/domain/worker-handoff.js";

const RECIPIENT = {
  controllerId: "orc:primary",
  familyId: "family:primary",
  scope: { kind: "fleet", scopeId: "local-broker" },
} as const;

const OPERATOR = {
  controllerId: "cyberdeck-operator",
  familyId: "cyberdeck-operator",
  scope: { kind: "fleet", scopeId: "local-broker" },
} as const;

function handoff(overrides: Partial<WorkerHandoff> = {}): WorkerHandoff {
  return WorkerHandoffSchema.parse({
    schemaVersion: 1,
    handoffId: randomUUID(),
    recipient: RECIPIENT,
    recipientSessionId: randomUUID(),
    issuedBy: OPERATOR,
    directive: "Land the review comments and open a PR each",
    manifest: [
      {
        workerId: randomUUID(),
        taskId: "task:one",
        name: "docs sweep",
        worktreePath: "/tmp/worktrees/one",
        lifecycle: "working",
        priorControllerId: "orc:previous",
      },
    ],
    issuedAt: "2026-08-18T10:00:00.000Z",
    state: "pending",
    ...overrides,
  });
}

describe("worker handoff record", () => {
  it("refuses a handoff with no directive and one with no members", () => {
    expect(() => handoff({ directive: "   " })).toThrow();
    expect(() => handoff({ manifest: [] })).toThrow();
  });

  it("refuses a manifest larger than the batch limit", () => {
    const oversized = Array.from({ length: HANDOFF_LIMITS.manifestEntries + 1 }, () => ({
      workerId: randomUUID(),
      taskId: "task:bulk",
      lifecycle: "working" as const,
    }));
    expect(() => handoff({ manifest: oversized })).toThrow();
  });

  it("records explicit acknowledgement while still parsing legacy consumed records", () => {
    expect(handoff({
      state: "acknowledged",
      acknowledgedAt: "2026-08-18T10:01:00.000Z",
    }).state).toBe("acknowledged");
    expect(handoff({
      state: "consumed",
      consumedAt: "2026-08-18T10:01:00.000Z",
    }).state).toBe("consumed");
  });

  it("names every adopted worker, its origin, and the directive in one briefing", () => {
    const record = handoff();
    const briefing = handoffBriefing(record);
    expect(briefing).toContain(record.handoffId);
    expect(briefing).toContain("You now hold the lease on 1 worker.");
    expect(briefing).toContain("Directive: Land the review comments and open a PR each");
    expect(briefing).toContain("docs sweep");
    expect(briefing).toContain("previously orc:previous");
    expect(briefing).toContain("/tmp/worktrees/one");
    // The recipient already holds these leases; telling it to adopt again would have it fight the
    // substrate for what it was just handed.
    expect(briefing).toContain("without adopting again");
  });

  it("says an unheld worker was the operator's own rather than inventing a prior controller", () => {
    const briefing = handoffBriefing(handoff({
      manifest: [{ workerId: randomUUID(), taskId: "task:manual", lifecycle: "waiting" }],
    }));
    expect(briefing).toContain("previously operator-held");
  });

  it("pluralises the roster count", () => {
    const briefing = handoffBriefing(handoff({
      manifest: [
        { workerId: randomUUID(), taskId: "task:one", lifecycle: "working" },
        { workerId: randomUUID(), taskId: "task:two", lifecycle: "working" },
      ],
    }));
    expect(briefing).toContain("You now hold the lease on 2 workers.");
  });
});
