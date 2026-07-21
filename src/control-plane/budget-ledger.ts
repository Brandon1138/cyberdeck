import { CONTROL_PLANE_SCHEMA_VERSION } from "../domain/control-plane.js";
import type { BudgetDeclaration, BudgetUsage } from "../domain/budget.js";
import type { UsageReport } from "../domain/usage.js";

export type BudgetBlockReason =
  | "MAX_JOBS"
  | "MAX_WALL_CLOCK_MS"
  | "MAX_TOTAL_TOKENS"
  | "MAX_ARTIFACT_BYTES"
  | "UNPROVABLE_TOKEN_USAGE";

export type BudgetDecision =
  | { ok: true }
  | { ok: false; code: "BUDGET_EXCEEDED"; reason: BudgetBlockReason };

export interface SettlementDebit {
  usage?: UsageReport;
  artifactBytes?: number;
}

export interface BudgetScopeReport {
  scopeId: string;
  usage: BudgetUsage;
  exhausted: boolean;
  reason?: BudgetBlockReason;
}

export interface BudgetReport {
  declaration: BudgetDeclaration;
  scopes: BudgetScopeReport[];
}

export interface BudgetLedgerOptions {
  declaration: BudgetDeclaration;
  now?: () => string;
}

interface ScopeState {
  startedAt: number;
  admitted: Set<string>;
  settled: Set<string>;
  /** Absent until some job actually reports tokens; absence is unknown, not zero. */
  totalTokens?: number;
  artifactBytes: number;
  jobsWithUnknownUsage: number;
}

/**
 * Explicit budget accounting for one budget scope per job tree.
 *
 * **Scope.** A scope id is the root job of a delegation tree; the control plane resolves it by
 * walking `parentJobId`. A delegated child therefore debits its parent's/root's budget rather than
 * getting a fresh allowance, and every debit is keyed by job id so it applies exactly once no matter
 * how many times admission is retried or a duplicate report arrives.
 *
 * **Units.** Only what the control plane can measure: admitted jobs, elapsed wall clock, reported
 * tokens, and persisted artifact bytes. There is no model, role, or currency cost model.
 *
 * **Admission vs. post-run.** Job count, elapsed time, and already-recorded token/byte totals are
 * enforced *at admission* — before a slot is reserved or a provider is launched. Tokens and bytes
 * can only be observed *after* a job settles, so they are debited post-run and then bound the next
 * admission. A running job is never killed mid-flight to reclaim budget.
 *
 * **Fail closed.** When a token ceiling is declared but some settled job reported no usage, the
 * remaining headroom is unprovable. The ledger then refuses further admission
 * (`UNPROVABLE_TOKEN_USAGE`) instead of assuming the unreported job cost zero.
 */
export class BudgetLedger {
  private readonly scopes = new Map<string, ScopeState>();

  constructor(private readonly options: BudgetLedgerOptions) {}

  /** Decide whether one more job may start in `scopeId`, and count it when it may. */
  admit(scopeId: string, jobId: string): BudgetDecision {
    const scope = this.scopes.get(scopeId);
    if (scope?.admitted.has(jobId) === true) return { ok: true };

    const blocked = this.blockReason(scope);
    if (blocked !== undefined) return { ok: false, code: "BUDGET_EXCEEDED", reason: blocked };

    const opened = scope ?? this.open();
    opened.admitted.add(jobId);
    this.scopes.set(scopeId, opened);
    return { ok: true };
  }

  /** Debit one settled job exactly once. Unreported usage stays unknown and is counted as such. */
  settle(scopeId: string, jobId: string, debit: SettlementDebit): void {
    const scope = this.scopes.get(scopeId);
    if (scope === undefined || scope.settled.has(jobId)) return;
    scope.settled.add(jobId);

    const tokens = totalTokensOf(debit.usage);
    if (tokens === undefined) scope.jobsWithUnknownUsage += 1;
    else scope.totalTokens = (scope.totalTokens ?? 0) + tokens;
    if (debit.artifactBytes !== undefined) scope.artifactBytes += debit.artifactBytes;
  }

  usage(scopeId: string): BudgetUsage {
    const scope = this.scopes.get(scopeId);
    if (scope === undefined) {
      return {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        jobsStarted: 0,
        jobsSettled: 0,
        wallClockMs: 0,
        artifactBytes: 0,
        jobsWithUnknownUsage: 0,
        updatedAt: this.nowIso(),
      };
    }
    return {
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      jobsStarted: scope.admitted.size,
      jobsSettled: scope.settled.size,
      wallClockMs: Math.max(0, this.nowMs() - scope.startedAt),
      ...(scope.totalTokens !== undefined ? { totalTokens: scope.totalTokens } : {}),
      artifactBytes: scope.artifactBytes,
      jobsWithUnknownUsage: scope.jobsWithUnknownUsage,
      updatedAt: this.nowIso(),
    };
  }

  report(): BudgetReport {
    return {
      declaration: { ...this.options.declaration },
      scopes: [...this.scopes.entries()].map(([scopeId, scope]) => {
        const reason = this.blockReason(scope);
        return {
          scopeId,
          usage: this.usage(scopeId),
          exhausted: reason !== undefined,
          ...(reason !== undefined ? { reason } : {}),
        };
      }),
    };
  }

  private blockReason(scope: ScopeState | undefined): BudgetBlockReason | undefined {
    if (scope === undefined) return undefined;
    const { maxJobs, maxWallClockMs, maxTotalTokens, maxArtifactBytes } = this.options.declaration;
    if (maxJobs !== undefined && scope.admitted.size >= maxJobs) return "MAX_JOBS";
    if (maxWallClockMs !== undefined && this.nowMs() - scope.startedAt >= maxWallClockMs) {
      return "MAX_WALL_CLOCK_MS";
    }
    if (maxTotalTokens !== undefined) {
      if ((scope.totalTokens ?? 0) >= maxTotalTokens) return "MAX_TOTAL_TOKENS";
      // Some job settled without reporting usage: the remaining headroom cannot be proven.
      if (scope.jobsWithUnknownUsage > 0) return "UNPROVABLE_TOKEN_USAGE";
    }
    if (maxArtifactBytes !== undefined && scope.artifactBytes >= maxArtifactBytes) {
      return "MAX_ARTIFACT_BYTES";
    }
    return undefined;
  }

  private open(): ScopeState {
    return {
      startedAt: this.nowMs(),
      admitted: new Set(),
      settled: new Set(),
      artifactBytes: 0,
      jobsWithUnknownUsage: 0,
    };
  }

  private nowIso(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private nowMs(): number {
    return Date.parse(this.nowIso());
  }
}

/**
 * Prefer an explicitly reported total; otherwise sum reported input/output tokens. When a provider
 * reported nothing measurable the result is `undefined` — unknown, never zero.
 */
function totalTokensOf(usage: UsageReport | undefined): number | undefined {
  if (usage === undefined) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return undefined;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}
