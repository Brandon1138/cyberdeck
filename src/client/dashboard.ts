import type { AdmissionSnapshot } from "../control-plane/admission-scheduler.js";
import type { BudgetReport } from "../control-plane/budget-ledger.js";
import type { JobSnapshot } from "../control-plane/job-control-plane.js";
import type { ReconciliationReport } from "../control-plane/reconciler.js";
import type { SessionRecord } from "../domain/session.js";
import { RpcError } from "./rpc-client.js";

interface DashboardOutput {
  write(chunk: string): unknown;
}

interface DashboardSignals {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** The narrow transport the cockpit needs. `RpcClient` satisfies it. */
export interface DashboardTransport {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
}

/**
 * One rendering pass over the broker's state.
 *
 * A `null` panel means the broker did not answer that query — a broker composed without a control
 * plane, for example. It is deliberately distinct from an empty panel: "no jobs" and "the job
 * surface is unavailable" are different facts, and rendering the second as the first would invent a
 * healthy-and-idle cockpit out of a missing capability.
 */
export interface DashboardSnapshot {
  sessions: readonly SessionRecord[];
  jobs: readonly JobSnapshot[];
  queue: AdmissionSnapshot | null;
  budget: BudgetReport | null;
  reconciliation: ReconciliationView | null;
}

/**
 * The shape `control.reconciliation` actually puts on the wire.
 *
 * The shared {@link ReconciliationReport} carries `string | null`: the broker answers null before a
 * control-plane reconciliation pass, and the presentation renders that honest state as
 * "never reconciled".
 */
export type ReconciliationView = ReconciliationReport;

const UNAVAILABLE = "  unavailable — the broker did not answer this query";

/**
 * Collect one snapshot from the A5 control-plane surface.
 *
 * Only methods A5 already exposes are called; B5 adds no RPC method, CLI option, or control-plane
 * field. `METHOD_NOT_FOUND` degrades that one panel to `null`; every other error (a disconnected
 * broker above all) propagates, because a cockpit that silently renders an empty deck when the
 * broker is gone is worse than one that stops.
 */
export async function collectDashboardSnapshot(
  client: DashboardTransport,
): Promise<DashboardSnapshot> {
  const [sessions, jobs, queue, budget, reconciliation] = await Promise.all([
    optional<SessionRecord[]>(client, "session.list"),
    optional<JobSnapshot[]>(client, "job.list"),
    optional<AdmissionSnapshot>(client, "control.queue"),
    optional<BudgetReport>(client, "control.budget"),
    optional<ReconciliationView>(client, "control.reconciliation"),
  ]);
  return {
    sessions: sessions ?? [],
    jobs: jobs ?? [],
    queue,
    budget,
    reconciliation,
  };
}

async function optional<T>(client: DashboardTransport, method: string): Promise<T | null> {
  try {
    return await client.request<T>(method, {});
  } catch (error) {
    if (error instanceof RpcError && error.code === "METHOD_NOT_FOUND") return null;
    throw error;
  }
}

export function renderDashboard(snapshot: DashboardSnapshot): string {
  return [
    "CYBERDECK COCKPIT",
    "",
    ...sessionPanel(snapshot.sessions),
    "",
    ...jobPanel(snapshot.jobs),
    "",
    ...admissionPanel(snapshot.queue),
    "",
    ...budgetPanel(snapshot.budget),
    "",
    ...reconciliationPanel(snapshot.reconciliation),
    "",
  ].join("\n");
}

/**
 * Interactive runtimes. A session is a broker-owned PTY that may run indefinitely, which is what
 * makes its runtime mode `interactive`; the mode is a runtime/presentation distinction and never a
 * provider category. Attachment is rendered verbatim from the record: the broker enforces at most
 * one controller, and the cockpit does not invent a watcher count the contract does not carry.
 */
function sessionPanel(sessions: readonly SessionRecord[]): string[] {
  const lines = [
    "SESSIONS (interactive runtime — broker-owned PTY, at most one controller and many watchers)",
    ["SESSION", "PROVIDER", "MODEL", "ROLE", "RUNTIME", "SANDBOX", "EXECUTION", "ATTACHMENT", "CWD"]
      .join("\t"),
  ];
  if (sessions.length === 0) return [...lines, "  no interactive sessions"];
  for (const session of sessions) {
    lines.push([
      session.id.slice(0, 8),
      session.provider,
      session.model ?? "native-default",
      session.role ?? "unassigned",
      "interactive",
      session.sandbox,
      session.executionState,
      session.attachmentState,
      session.cwd,
    ].join("\t"));
  }
  return lines;
}

/**
 * Headless runtimes. A job is bounded work with a terminal outcome, so its runtime mode is
 * `headless`. Token usage is rendered `unknown` whenever the provider reported none — absence is
 * never displayed as zero.
 */
function jobPanel(jobs: readonly JobSnapshot[]): string[] {
  const lines = [
    "JOBS (headless runtime — bounded work with a terminal outcome)",
    ["JOB", "PROVIDER", "MODEL", "ROLE", "RUNTIME", "SANDBOX", "STATUS", "OUTCOME", "TOKENS", "CWD"]
      .join("\t"),
  ];
  if (jobs.length === 0) return [...lines, "  no jobs"];
  for (const job of jobs) {
    const { record } = job;
    lines.push([
      record.id.slice(0, 8),
      record.request.provider,
      record.request.model ?? "native-default",
      record.request.role ?? "unassigned",
      "headless",
      record.request.sandbox,
      record.lifecycle.status,
      record.lifecycle.status === "settled" ? record.lifecycle.result.outcome : "-",
      job.usage?.totalTokens === undefined ? "unknown" : String(job.usage.totalTokens),
      record.request.cwd,
    ].join("\t"));
  }
  return lines;
}

/** Admission capacity affects only *when* a job runs; it never substitutes or ranks a provider. */
function admissionPanel(queue: AdmissionSnapshot | null): string[] {
  if (queue === null) return ["ADMISSION", UNAVAILABLE];
  const limits = Object.entries(queue.limits)
    .filter(([key, value]) => key !== "schemaVersion" && value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const lines = [
    "ADMISSION",
    `  admission ${queue.admissionOpen ? "open" : "closed"}; ${queue.reservations.length} reserved slot(s)`,
    `  limits: ${limits === "" ? "none declared" : limits}`,
  ];
  if (queue.queued.length === 0) return [...lines, "  queue empty"];
  lines.push(["QUEUED", "PROVIDER", "REPOSITORY", "ENQUEUED", "BLOCKED BY"].join("\t"));
  for (const entry of queue.queued) {
    lines.push([
      entry.jobId.slice(0, 8),
      entry.provider,
      entry.repositoryKey,
      entry.enqueuedAt,
      entry.blockedBy,
    ].join("\t"));
  }
  return lines;
}

/**
 * Budgets are measured only in units the control plane actually holds. A scope whose settled jobs
 * reported no usage shows `unknown` tokens plus the count of unreporting jobs, so an operator can
 * see why a declared token ceiling would fail closed rather than reading a comforting zero.
 */
function budgetPanel(budget: BudgetReport | null): string[] {
  if (budget === null) return ["BUDGET", UNAVAILABLE];
  const declared = Object.entries(budget.declaration)
    .filter(([key, value]) => key !== "schemaVersion" && value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const lines = [
    "BUDGET",
    `  declared: ${declared === "" ? "no ceiling declared" : declared}`,
  ];
  if (budget.scopes.length === 0) return [...lines, "  no budget scopes"];
  lines.push(["SCOPE", "STARTED", "SETTLED", "WALL MS", "TOKENS", "ARTIFACT BYTES", "STATE"].join("\t"));
  for (const scope of budget.scopes) {
    lines.push([
      scope.scopeId.slice(0, 8),
      String(scope.usage.jobsStarted),
      String(scope.usage.jobsSettled),
      String(scope.usage.wallClockMs),
      scope.usage.totalTokens === undefined ? "unknown" : String(scope.usage.totalTokens),
      String(scope.usage.artifactBytes),
      scope.exhausted ? `exhausted (${scope.reason ?? "unspecified"})` : "within budget",
    ].join("\t"));
    if (scope.usage.jobsWithUnknownUsage > 0) {
      lines.push(
        `  ${scope.usage.jobsWithUnknownUsage} settled job(s) reported no usage; a declared token ceiling fails closed`,
      );
    }
  }
  return lines;
}

/**
 * Reconciliation findings are operator actions, never completed repairs. Reconciliation never
 * deletes, kills, resumes, or retries anything, and this panel must not imply that it did.
 */
function reconciliationPanel(report: ReconciliationView | null): string[] {
  if (report === null) return ["RECONCILIATION", UNAVAILABLE];
  if (report.reconciledAt === null) {
    return ["RECONCILIATION", "  never reconciled — no pass has run in this broker yet"];
  }
  const lines = [
    "RECONCILIATION",
    `  last pass ${report.reconciledAt}`,
    `  ${report.quarantinedJobIds.length} job(s) quarantined as unverifiable`,
  ];
  if (report.findings.length === 0) return [...lines, "  the pass returned nothing to report"];
  lines.push(["KIND", "SUBJECT", "DETAIL", "ACTION"].join("\t"));
  for (const finding of report.findings) {
    lines.push([
      finding.kind,
      finding.subject,
      finding.detail,
      finding.operatorActionRequired
        ? `operator action required: ${finding.suggestedAction}`
        : finding.suggestedAction,
    ].join("\t"));
  }
  return lines;
}

export async function runDashboard(
  client: DashboardTransport & { onClose(listener: () => void): () => void; close(): void },
  output: DashboardOutput = process.stdout,
  signals: DashboardSignals = process,
): Promise<void> {
  let stopped = false;
  const stop = () => { stopped = true; };
  const unsubscribeClose = client.onClose(stop);
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);

  try {
    while (!stopped) {
      const snapshot = await collectDashboardSnapshot(client);
      output.write(`\u001b[2J\u001b[H${renderDashboard(snapshot)}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } finally {
    unsubscribeClose();
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
    client.close();
  }
}
