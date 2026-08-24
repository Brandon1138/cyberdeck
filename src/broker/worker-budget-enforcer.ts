import { createHash } from "node:crypto";
import type { SessionRecord } from "../domain/session.js";
import type { ControllerIdentity, OwnershipMutationResult } from "../domain/worker-coordination.js";
import {
  type WorkerBudgetDeclaration,
  type WorkerBudgetMeasurement,
  type WorkerBudgetRecord,
  type WorkerProviderRemaining,
} from "../domain/worker-budget.js";
import type {
  WorkerBudgetObservation,
  WorkerBudgetGate,
  SessionRegistry,
} from "./session-registry.js";
import type {
  AdvanceBudgetEnforcementInput,
  ObserveBudgetInput,
  WorkerCoordinationService,
} from "./worker-coordination.js";
import type { WorkerLeaseCredentialCustodian } from "./worker-lease-credential-custodian.js";
import type { InstructionQueue } from "../orchestration/instruction-queue.js";

const DEFAULT_CHECK_INTERVAL_MS = 1_000;
const MIN_CHECK_INTERVAL_MS = 100;
const MIN_STALE_AFTER_MS = 10_000;
const WRAP_UP_MESSAGE = [
  "Scoped worker budget reached its soft limit.",
  "Wrap up current work now, preserve results, and summarize remaining work before the hard cap stops further work.",
].join(" ");

type BudgetRegistry = Pick<
  SessionRegistry,
  "get" | "list" | "onSessionUpdate" | "stop" | "workerBudgetObservation" | "workerTruth"
>;

type BudgetCoordination = Pick<
  WorkerCoordinationService,
  | "advanceBudgetEnforcement"
  | "getBudget"
  | "listSubjects"
  | "observeBudget"
  | "onBudgetUpdate"
  | "reconcileLifecycle"
  | "registerSubject"
>;

type BudgetInstructions = Pick<InstructionQueue, "enqueueBroker">;
interface ParsedProviderBudgetTelemetry {
  totalTokens?: number;
  tokenObservedAt?: string;
  providerUsage?: {
    window: "weekly" | "session";
    usedPercent: number;
    remainingPercent: number;
    observedAt: string;
  };
}

interface BudgetTranscripts {
  readProviderBudgetTelemetry(input: {
    sessionId: string;
    provider: string;
    cwd: string;
    createdAt: string;
    turnNumber: number;
  }, window: "weekly" | "session"): Promise<ParsedProviderBudgetTelemetry>;
}

export interface WorkerBudgetRegistrationInput {
  record: SessionRecord;
  name: string;
  declaration: WorkerBudgetDeclaration;
  controller: ControllerIdentity;
}

export interface WorkerBudgetEnforcerOptions {
  registry: BudgetRegistry;
  coordination: BudgetCoordination;
  instructions: BudgetInstructions;
  transcripts?: BudgetTranscripts;
  credentials?: Pick<WorkerLeaseCredentialCustodian, "set">;
  now?: () => number;
  intervalMs?: number;
  providerTelemetryStaleAfterMs?: number;
  onBackgroundError?: (workerId: string, error: unknown) => void;
}

/**
 * Broker-owned measurement and enforcement loop for scoped worker allowances.
 *
 * Durable coordination state always moves to a threshold state before this class performs the
 * corresponding side effect. The synchronous gate reads that state directly, so every registry
 * consumption path is refused as soon as a hard threshold commit completes, even if process stop
 * is still pending or needs a retry after restart.
 */
export class WorkerBudgetEnforcer implements WorkerBudgetGate {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly providerTelemetryStaleAfterMs: number;
  private readonly unsubscribes: Array<() => void> = [];
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastCheckedAt = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private started = false;

  constructor(private readonly options: WorkerBudgetEnforcerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = Math.max(MIN_CHECK_INTERVAL_MS, options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
    this.providerTelemetryStaleAfterMs = Math.max(
      this.intervalMs * 3,
      options.providerTelemetryStaleAfterMs ?? 60_000,
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unsubscribes.push(
      this.options.registry.onSessionUpdate((workerId) => this.schedule(workerId)),
      this.options.coordination.onBudgetUpdate((workerId) => this.schedule(workerId)),
    );
    try {
      await this.refreshAll();
    } catch (error) {
      this.close();
      throw error;
    }
    this.interval = setInterval(() => {
      void this.refreshAll().catch((error) => {
        this.options.onBackgroundError?.("*", error);
      });
    }, this.intervalMs);
    this.interval.unref();
  }

  close(): void {
    if (!this.started) return;
    this.started = false;
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }

  assertMayConsume(sessionId: string): void {
    const state = this.options.coordination.getBudget(sessionId)?.enforcement.state;
    if (state !== "hard-reached" && state !== "hard-stop-requested") return;
    throw Object.assign(
      new Error(`Worker ${sessionId} hard budget reached; further work refused`),
      { code: "WORKER_BUDGET_EXHAUSTED" as const },
    );
  }

  /** Durable activation callback used by standard worker spawn before provider initialization. */
  async register(input: WorkerBudgetRegistrationInput): Promise<void> {
    const result = await this.options.coordination.registerSubject({
      mutationId: `worker-budget:register:${input.record.id}`,
      actor: input.controller,
      subjectId: input.record.id,
      subjectKind: "worker",
      origin: {
        creatorControllerId: input.controller.controllerId,
        ...(input.record.parentSessionId === undefined
          ? {}
          : { creatorSessionId: input.record.parentSessionId }),
        taskId: input.record.id,
        threadId: input.record.id,
        createdAt: input.record.createdAt,
      },
      lifecycle: "working",
      resources: {
        sessionId: input.record.id,
        worktreePath: input.record.cwd,
        transcriptRef: `thread:${input.record.id}`,
        resultStateRef: `session:${input.record.id}`,
        eventStreamId: `worker:${input.record.id}`,
      },
      controller: input.controller,
      budget: input.declaration,
      reason: `register broker-owned scoped budget for worker ${input.record.id}`,
    });
    this.captureCredential(input.controller, result);
    if (this.started) this.schedule(input.record.id, true);
  }

  async markLaunchFailed(input: { workerId: string; reason: string }): Promise<void> {
    await this.options.coordination.reconcileLifecycle({
      mutationId: `worker-budget:launch-failed:${input.workerId}`,
      subjectId: input.workerId,
      lifecycle: "failed",
      reason: truncateReason(`budgeted worker launch failed: ${input.reason}`),
    });
  }

  async refreshAll(): Promise<void> {
    const workerIds = this.options.coordination.listSubjects()
      .filter((subject) => subject.subjectKind === "worker" && subject.budget !== undefined)
      .map((subject) => subject.subjectId);
    await Promise.all(workerIds.map((workerId) => this.refresh(workerId)));
  }

  async refresh(workerId: string): Promise<void> {
    const previous = this.tails.get(workerId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.refreshWorker(workerId));
    this.tails.set(workerId, next);
    try {
      await next;
    } finally {
      if (this.tails.get(workerId) === next) this.tails.delete(workerId);
    }
  }

  private async refreshWorker(workerId: string): Promise<void> {
    this.lastCheckedAt.set(workerId, this.now());
    let budget = this.options.coordination.getBudget(workerId);
    if (budget === undefined) return;
    const record = this.session(workerId);
    if (record === undefined) return;

    await this.enforcePending(record, budget);
    budget = this.options.coordination.getBudget(workerId) ?? budget;
    if (this.options.registry.workerTruth(workerId).terminal) return;
    if (budget.enforcement.state === "hard-reached" || budget.enforcement.state === "hard-stop-requested") {
      return;
    }

    const observation = await this.observe(record, budget);
    if (observation === undefined) return;
    const result = await this.options.coordination.observeBudget(observation);
    // Receipt replay returns snapshot originally committed for that mutation. Enforcement may have
    // advanced since then, so side effects must follow current broker state, never stale receipt data.
    await this.enforcePending(
      record,
      this.options.coordination.getBudget(workerId) ?? result.budget,
    );
  }

  private async observe(
    record: SessionRecord,
    budget: WorkerBudgetRecord,
  ): Promise<ObserveBudgetInput | undefined> {
    const now = this.now();
    const observedAt = new Date(now).toISOString();
    const runtime = this.options.registry.workerBudgetObservation(record.id);
    const telemetry = await this.providerTelemetry(record, budget, runtime);
    const providerRemaining = this.providerRemaining(telemetry);
    const measurement = this.measurement(record, budget, runtime, telemetry, observedAt);
    if (measurement === undefined && providerRemaining === undefined) return undefined;
    const nextMeasurement = measurement ?? budget.measurement;
    const fingerprint = stableHash({
      measurement: nextMeasurement,
      providerRemaining: providerRemaining ?? null,
    });
    return {
      mutationId: `worker-budget:observe:${record.id}:${fingerprint}`,
      subjectId: record.id,
      measurement: nextMeasurement,
      ...(providerRemaining === undefined ? {} : { providerRemaining }),
      reason: "broker usage observation",
    };
  }

  private measurement(
    record: SessionRecord,
    budget: WorkerBudgetRecord,
    runtime: WorkerBudgetObservation,
    telemetry: ParsedProviderBudgetTelemetry,
    observedAt: string,
  ): WorkerBudgetMeasurement | undefined {
    const unit = budget.declaration.allocation.unit;
    const staleAfterMs = Math.max(MIN_STALE_AFTER_MS, this.intervalMs * 3);
    if (unit === "wall-clock-ms") {
      return {
        status: "known",
        unit,
        amount: Math.max(0, this.now() - Date.parse(record.createdAt)),
        source: "wall-clock",
        quality: "approximate",
        observedAt,
        staleAfterMs,
      };
    }
    if (unit === "tokens") {
      if (telemetry.totalTokens !== undefined) {
        const current = budget.measurement.status === "known" ? budget.measurement.amount : 0;
        return {
          status: "known",
          unit,
          amount: Math.max(current, telemetry.totalTokens),
          source: "provider-telemetry",
          quality: "exact",
          observedAt: telemetry.tokenObservedAt ?? observedAt,
          staleAfterMs: this.providerTelemetryStaleAfterMs,
          generation: runtime.generation,
        };
      }
      if (runtime.tokenCount !== undefined) {
        const current = budget.measurement.status === "known" ? budget.measurement.amount : 0;
        return {
          status: "known",
          unit,
          amount: Math.max(current, runtime.tokenCount),
          source: "terminal-token-counter",
          quality: "approximate",
          observedAt,
          staleAfterMs,
          generation: runtime.generation,
        };
      }
      return undefined;
    }

    const usage = telemetry.providerUsage;
    if (usage === undefined) return undefined;
    const priorConsumed = budget.measurement.status === "known" ? budget.measurement.amount : 0;
    const priorRemaining = budget.providerRemaining.status === "available"
      && budget.providerRemaining.unit === "percent"
      ? budget.providerRemaining.amount
      : undefined;
    const consumedDelta = priorRemaining === undefined
      ? 0
      : Math.max(0, priorRemaining - usage.remainingPercent);
    return {
      status: "known",
      unit: "percent",
      amount: priorConsumed + consumedDelta,
      source: "provider-telemetry",
      quality: "approximate",
      observedAt: usage.observedAt,
      staleAfterMs: this.providerTelemetryStaleAfterMs,
      generation: runtime.generation,
    };
  }

  private async providerTelemetry(
    record: SessionRecord,
    budget: WorkerBudgetRecord,
    runtime: WorkerBudgetObservation,
  ): Promise<ParsedProviderBudgetTelemetry> {
    if (this.options.transcripts === undefined) return {};
    try {
      return await this.options.transcripts.readProviderBudgetTelemetry({
        sessionId: record.id,
        provider: record.provider,
        cwd: record.cwd,
        createdAt: record.createdAt,
        turnNumber: runtime.canonicalTurns,
      }, budget.declaration.resource);
    } catch {
      // Provider-native telemetry is optional and may disappear or lag. Existing durable readings
      // age to stale; a transient reader failure must not suppress wall-clock/terminal enforcement.
      return {};
    }
  }

  private providerRemaining(
    telemetry: ParsedProviderBudgetTelemetry,
  ): WorkerProviderRemaining | undefined {
    const usage = telemetry.providerUsage;
    if (usage === undefined) return undefined;
    return {
      status: "available",
      unit: "percent",
      amount: usage.remainingPercent,
      quality: "approximate",
      observedAt: usage.observedAt,
      staleAfterMs: this.providerTelemetryStaleAfterMs,
    };
  }

  private async enforcePending(record: SessionRecord, budget: WorkerBudgetRecord): Promise<void> {
    if (budget.enforcement.state === "soft-pending") {
      if (this.options.registry.workerTruth(record.id).terminal) return;
      await this.options.instructions.enqueueBroker({
        actorSessionId: record.parentSessionId ?? record.id,
        targetSessionId: record.id,
        message: WRAP_UP_MESSAGE,
        messageId: stableUuid(`worker-budget:soft:${record.id}:${budget.revision}`),
      });
      await this.advance({
        mutationId: `worker-budget:soft-notified:${record.id}:r${budget.revision}`,
        subjectId: record.id,
        expectedRevision: budget.revision,
        state: "soft-notified",
        reason: "broker persisted wrap-up instruction",
      });
      return;
    }
    if (budget.enforcement.state !== "hard-reached") return;
    if (this.options.registry.workerTruth(record.id).terminal) return;
    await this.options.registry.stop(record.id);
    await this.advance({
      mutationId: `worker-budget:hard-stop-requested:${record.id}:r${budget.revision}`,
      subjectId: record.id,
      expectedRevision: budget.revision,
      state: "hard-stop-requested",
      reason: "broker stopped worker at hard budget cap",
    });
  }

  private advance(input: AdvanceBudgetEnforcementInput): Promise<unknown> {
    return this.options.coordination.advanceBudgetEnforcement(input);
  }

  private schedule(workerId: string, immediate = false): void {
    if (!this.started || this.options.coordination.getBudget(workerId) === undefined) return;
    if (this.scheduled.has(workerId)) return;
    const elapsed = this.now() - (this.lastCheckedAt.get(workerId) ?? 0);
    const delay = immediate ? 0 : Math.max(0, this.intervalMs - elapsed);
    const timer = setTimeout(() => {
      this.scheduled.delete(workerId);
      void this.refresh(workerId).catch((error) => {
        this.options.onBackgroundError?.(workerId, error);
      });
    }, delay);
    timer.unref();
    this.scheduled.set(workerId, timer);
  }

  private session(workerId: string): SessionRecord | undefined {
    try {
      return this.options.registry.get(workerId);
    } catch {
      return undefined;
    }
  }

  private captureCredential(controller: ControllerIdentity, result: OwnershipMutationResult): void {
    const outcome = result.outcomes.find(({ leaseToken }) => leaseToken !== undefined);
    if (outcome?.leaseToken === undefined || outcome.leaseVersion === undefined) return;
    this.options.credentials?.set(controller.controllerId, outcome.subjectId, {
      leaseToken: outcome.leaseToken,
      leaseVersion: outcome.leaseVersion,
    });
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function truncateReason(value: string): string {
  return value.length <= 1_024 ? value : value.slice(0, 1_024);
}
