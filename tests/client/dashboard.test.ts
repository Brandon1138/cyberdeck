import { describe, expect, it, vi } from "vitest";
import {
  collectDashboardSnapshot,
  renderDashboard,
  type DashboardSnapshot,
} from "../../src/client/dashboard.js";
import { RpcError } from "../../src/client/rpc-client.js";
import type { SessionRecord } from "../../src/domain/session.js";
import {
  CONTROL_PLANE_SCHEMA_VERSION,
  CorrelationIdSchema,
  JobIdSchema,
} from "../../src/domain/control-plane.js";

const NOW = "2026-07-21T10:00:00.000Z";
const JOB_ID = JobIdSchema.parse("22222222-2222-4222-8222-222222222222");
const CORRELATION_ID = CorrelationIdSchema.parse("33333333-3333-4333-8333-333333333333");

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    cwd: "/repo",
    detached: true,
    sandbox: "read-only",
    createdAt: NOW,
    updatedAt: NOW,
    executionState: "active",
    attachmentState: "controlled",
    pid: 4321,
    exitCode: null,
    childIds: [],
    ...overrides,
  } as SessionRecord;
}

function emptySnapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    sessions: [],
    jobs: [],
    queue: null,
    budget: null,
    reconciliation: null,
    ...overrides,
  };
}

describe("renderDashboard", () => {
  it("labels a session runtime interactive and a job runtime headless", () => {
    const rendered = renderDashboard(emptySnapshot({
      sessions: [session()],
      jobs: [{
        record: {
          schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
          id: JOB_ID,
          correlationId: CORRELATION_ID,
          request: {
            schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
            provider: "cursor",
            cwd: "/repo",
            sandbox: "read-only",
            instruction: "summarise",
          },
          lifecycle: { status: "running", startedAt: NOW },
          createdAt: NOW,
          updatedAt: NOW,
        },
      }],
    }));

    expect(rendered).toMatch(/SESSIONS \(interactive runtime/);
    expect(rendered).toMatch(/JOBS \(headless runtime/);
    // The session row is the interactive one; the job row is the headless one.
    const sessionRow = rendered.split("\n").find((line) => line.includes("11111111"));
    const jobRow = rendered.split("\n").find((line) => line.includes("22222222"));
    expect(sessionRow).toContain("interactive");
    expect(jobRow).toContain("headless");
  });

  it("renders an omitted model as native-default and an omitted role as unassigned", () => {
    const rendered = renderDashboard(emptySnapshot({ sessions: [session()] }));
    expect(rendered).toContain("native-default");
    expect(rendered).toContain("unassigned");
  });

  it("renders an explicit model verbatim without substituting one", () => {
    const rendered = renderDashboard(
      emptySnapshot({ sessions: [session({ model: "claude-opus-4-8", role: "reviewer" })] }),
    );
    expect(rendered).toContain("claude-opus-4-8");
    expect(rendered).toContain("reviewer");
    expect(rendered).not.toContain("native-default");
  });

  it("reports unknown token usage as unknown and never as zero", () => {
    const rendered = renderDashboard(emptySnapshot({
      budget: {
        declaration: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION },
        scopes: [{
          scopeId: "44444444-4444-4444-8444-444444444444",
          usage: {
            schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
            jobsStarted: 2,
            jobsSettled: 2,
            wallClockMs: 1_500,
            artifactBytes: 0,
            jobsWithUnknownUsage: 2,
            updatedAt: NOW,
          },
          exhausted: false,
        }],
      },
    }));

    const scopeRow = rendered.split("\n").find((line) => line.includes("44444444"));
    expect(scopeRow).toContain("unknown");
    expect(scopeRow).not.toMatch(/\b0 tokens\b/);
    expect(rendered).toContain("2 settled job(s) reported no usage");
  });

  it("marks an unavailable control-plane panel as unavailable rather than empty", () => {
    const rendered = renderDashboard(emptySnapshot());
    expect(rendered).toMatch(/ADMISSION\n\s*unavailable/);
    expect(rendered).toMatch(/BUDGET\n\s*unavailable/);
    expect(rendered).toMatch(/RECONCILIATION\n\s*unavailable/);
  });

  it("states the never-reconciled case explicitly instead of implying a clean pass", () => {
    const rendered = renderDashboard(emptySnapshot({
      reconciliation: { reconciledAt: null, findings: [], quarantinedJobIds: [] },
    }));
    expect(rendered).toContain("never reconciled");
    expect(rendered).not.toContain("no findings");
  });

  it("shows reconciliation findings as operator actions and never as completed repairs", () => {
    const rendered = renderDashboard(emptySnapshot({
      reconciliation: {
        reconciledAt: NOW,
        findings: [{
          kind: "orphaned-runtime",
          subject: "pid 999",
          detail: "runtime is not owned by any durable job",
          operatorActionRequired: true,
          suggestedAction: "inspect the process before terminating it",
          destructive: false,
        }],
        quarantinedJobIds: ["55555555-5555-4555-8555-555555555555"],
      },
    }));
    expect(rendered).toContain("operator action required");
    expect(rendered).toContain("inspect the process before terminating it");
    expect(rendered).toContain("quarantined");
    expect(rendered).not.toMatch(/repaired|resolved|fixed|killed/i);
  });

  it("states the one-controller/many-watcher invariant without inventing watcher counts", () => {
    const rendered = renderDashboard(emptySnapshot({
      sessions: [session({ attachmentState: "watched" })],
    }));
    expect(rendered).toContain("at most one controller");
    expect(rendered).toContain("watched");
  });

  it("renders no provider ranking, recommendation, or default-choice language", () => {
    const rendered = renderDashboard(emptySnapshot({ sessions: [session()] }));
    expect(rendered).not.toMatch(/recommend|best|preferred|fastest|rank|#1|fallback|auto-select/i);
  });

  it("never renders a Fable model as a suggestion of its own", () => {
    const rendered = renderDashboard(emptySnapshot({ sessions: [session()] }));
    expect(rendered).not.toMatch(/fable/i);
  });

  it("emits no ANSI escape sequences inside the rendered body", () => {
    const rendered = renderDashboard(emptySnapshot({ sessions: [session()] }));
    // Screen clearing belongs to runDashboard's transport write, not to the rendered body,
    // so shared UI carries no terminal- or provider-specific escape handling.
    expect(rendered).not.toContain(String.fromCharCode(27));
  });
});

describe("collectDashboardSnapshot", () => {
  it("queries the A5 control-plane surface without inventing new methods", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "session.list": return [];
        case "job.list": return [];
        case "control.queue": return { limits: {}, admissionOpen: true, reservations: [], queued: [] };
        case "control.budget": return { declaration: {}, scopes: [] };
        case "control.reconciliation": return { reconciledAt: null, findings: [], quarantinedJobIds: [] };
        default: throw new Error(`unexpected method ${method}`);
      }
    });

    const snapshot = await collectDashboardSnapshot({ request } as never);

    expect(request.mock.calls.map((call) => call[0]).sort()).toEqual([
      "control.budget",
      "control.queue",
      "control.reconciliation",
      "job.list",
      "session.list",
    ]);
    expect(snapshot.queue).not.toBeNull();
  });

  it("degrades a control-plane-less broker to null panels instead of failing", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "session.list") return [];
      throw new RpcError("METHOD_NOT_FOUND", `Unknown method ${method}`);
    });

    const snapshot = await collectDashboardSnapshot({ request } as never);

    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.queue).toBeNull();
    expect(snapshot.budget).toBeNull();
    expect(snapshot.reconciliation).toBeNull();
  });

  it("propagates a disconnected broker rather than rendering a false empty cockpit", async () => {
    const request = vi.fn(async () => {
      throw new RpcError("BROKER_DISCONNECTED", "Broker connection is closed");
    });

    await expect(collectDashboardSnapshot({ request } as never)).rejects.toThrow(/BROKER_DISCONNECTED|closed/);
  });
});
