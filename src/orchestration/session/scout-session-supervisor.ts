import type { SessionRecord } from "../../domain/session.js";
import type { ScoutDecisionCard } from "../../domain/scout-output.js";
import type {
  ScoutArtifactKind,
  ScoutRuntimeState,
} from "../../domain/worker-profile.js";
import type { ScoutArtifactRead } from "./session-ports.js";
import type {
  ScoutFinalizationOutcome,
  ScoutReportCapture,
  ScoutReportPort,
  ScoutSupervisionEffects,
  ScoutWorkspaceVerificationPort,
} from "./scout-supervision-ports.js";

/**
 * Why supervising a Scout refused, with the code the caller reports.
 *
 * Separate from the registry's own error type for the same reason the workspace coordinator's is:
 * this layer knows what is missing from Scout supervision, not what a broker RPC calls it. The
 * registry translates one into the other, code and message unchanged.
 */
export type ScoutSupervisionErrorCode = "SCOUT_REPORT_STORE_UNAVAILABLE";

export class ScoutSupervisionError extends Error {
  constructor(readonly code: ScoutSupervisionErrorCode, message: string) {
    super(message);
    this.name = "ScoutSupervisionError";
  }
}

export interface ScoutSessionSupervisorOptions {
  /**
   * The broker-owned drop box. Absent means this broker cannot run Scouts at all: a start that asks
   * for one is refused rather than launched into a probe whose report has nowhere to land.
   */
  reports?: ScoutReportPort | undefined;
  workspace: ScoutWorkspaceVerificationPort;
}

const PREVIEW_STORAGE_LIMIT = 600;

/** Creates one supervisor per Scout session, and nothing at all for every other session. */
export class ScoutSessionSupervisorFactory {
  constructor(private readonly options: ScoutSessionSupervisorOptions) {}

  /**
   * Cut the drop box a Scout start will write into, before any provider process exists.
   *
   * Lives on the factory rather than on a supervisor because it runs before the record that a
   * supervisor is built from: its answer *is* the record's durable Scout state.
   */
  async initialize(sessionId: string, cwd: string): Promise<ScoutRuntimeState> {
    return this.requireReports().initialize(sessionId, cwd);
  }

  /**
   * A supervisor for a Scout, and `undefined` for anything else.
   *
   * An ordinary session instantiates none: every Scout-only timer, tail, and cutoff lives behind
   * this reference, so a worker that is not a Scout carries no Scout runtime state to reason about.
   */
  create(
    record: SessionRecord,
    effects: ScoutSupervisionEffects,
  ): ScoutSessionSupervisor | undefined {
    return record.profile === "scout"
      ? new ScoutSessionSupervisor(record, effects, this.options)
      : undefined;
  }

  /**
   * Give back a deleted thread's drop box. Silent on a broker with no Scout storage, because such a
   * broker never created one.
   */
  async discardReports(sessionId: string): Promise<void> {
    await this.options.reports?.remove(sessionId);
  }

  private requireReports(): ScoutReportPort {
    const reports = this.options.reports;
    if (reports === undefined) {
      throw new ScoutSupervisionError(
        "SCOUT_REPORT_STORE_UNAVAILABLE",
        "Scout profile requires broker-owned drop-box storage",
      );
    }
    return reports;
  }
}

/**
 * Owns everything that is true of a Scout and of nothing else.
 *
 * A Scout is a one-shot probe with a wall clock, a drop box, a durable trace, and a read-only claim
 * that has to be verified after the fact. All of that used to sit in `SessionRegistry` as ten
 * optional fields on every runtime session, checked with a profile test at each use — which meant
 * every ordinary worker carried Scout state that could only ever be undefined, and every Scout rule
 * was stated once per call site.
 *
 * The pieces belong together because they share one ordering constraint that nothing else in the
 * registry has: a Scout's terminal result is decided *before* its process exit is published, and
 * once decided it cannot be promoted. The cutoff persists before it kills, the capture tail settles
 * before finalization reads it, and a card that arrives after either is durable evidence, not a new
 * outcome.
 *
 * What stays at the registry: the canonical lifecycle exit. This settles Scout truth and returns an
 * outcome; publishing execution state, attention, and the exit code remains one path for every
 * session, Scout or not.
 */
export class ScoutSessionSupervisor {
  /** Serializes framed drop-box capture so older runtime snapshots cannot overwrite newer ones. */
  private captureTail?: Promise<void>;
  /** Serializes the full provider stream into the durable trace artifact. */
  private traceTail?: Promise<void>;
  private traceFailure?: string;
  /** Prevents duplicate finalization when a child process reports more than one close path. */
  private finalizing = false;
  private budgetTimer?: ReturnType<typeof setTimeout>;
  private budgetActive = false;
  private exhaustingBudget = false;
  private cutoffStarted = false;
  private expectedSuccessfulStop = false;
  private acceptedCardStopRequested = false;
  private card?: ScoutDecisionCard;

  constructor(
    private readonly record: SessionRecord,
    private readonly effects: ScoutSupervisionEffects,
    private readonly options: ScoutSessionSupervisorOptions,
  ) {}

  /** Whether this Scout's provider speaks the one-shot JSON stream rather than a live terminal. */
  get streamsHeadless(): boolean {
    return this.record.scout?.transport === "headless-stream-json";
  }

  /** Whether a wall-clock cutoff is mid-flight, which suspends ordinary turn completion. */
  isBudgetExhausting(): boolean {
    return this.exhaustingBudget;
  }

  /** The parsed decision card this Scout produced, if it has produced one. */
  decisionCard(): ScoutDecisionCard | undefined {
    const card = this.card;
    return card === undefined ? undefined : { ...card, evidence: [...card.evidence] };
  }

  async readArtifact(
    artifact: ScoutArtifactKind,
    afterByte = 0,
    maxBytes = 16 * 1024,
  ): Promise<ScoutArtifactRead> {
    const scout = this.requireState();
    return this.requireReports().readArtifact(scout, artifact, afterByte, maxBytes);
  }

  /**
   * Fold one chunk of provider output into the Scout's durable artifacts.
   *
   * `replay` is a thunk because the registry calls this from the broadcast path: materializing the
   * whole replay for a Scout that has already reached a terminal state is a copy and a decode of the
   * entire buffer for a reading nobody will use.
   */
  observeOutput(chunk: Buffer, replay: () => string): void {
    if (this.streamsHeadless) this.appendTrace(chunk);
    this.captureReport(replay);
  }

  /**
   * Start this Scout's wall clock. Called once the probe can actually act — after a deferred initial
   * prompt is submitted, not while the provider is still setting itself up.
   */
  armBudget(): void {
    const budget = this.record.brief?.budget;
    if (budget === undefined || this.budgetActive) return;
    this.budgetActive = true;
    this.budgetTimer = setTimeout(() => {
      void this.exhaustBudget("time", budget.maxWallClockMs);
    }, budget.maxWallClockMs);
    this.budgetTimer.unref?.();
  }

  /**
   * End this Scout's wall-clock ownership.
   *
   * Every process exit reaches here, including a legacy interactive-PTY Scout's. A surviving timer
   * could otherwise rewrite an already-published exit as budget exhaustion and kill a dead handle.
   */
  releaseBudget(): void {
    if (this.budgetTimer !== undefined) clearTimeout(this.budgetTimer);
    delete this.budgetTimer;
    this.budgetActive = false;
  }

  /**
   * Settle Scout truth for a process that has exited, and say whether this call owns that exit.
   *
   * `replay` is bound by the caller to the exact handle that exited, so a replacement generation's
   * screen can never be read as this process's final report.
   */
  async finalizeExit(exitCode: number, replay: () => string): Promise<ScoutFinalizationOutcome> {
    if (this.finalizing) return { status: "duplicate" };
    this.finalizing = true;
    this.releaseBudget();

    const scout = this.record.scout;
    if (scout === undefined) return { status: "settled" };

    this.captureReport(replay);
    await this.captureTail?.catch(() => undefined);
    await this.traceTail?.catch(() => undefined);

    if (this.traceFailure !== undefined) {
      await this.markFinalFailure(
        "verify",
        `Durable Scout trace could not be persisted: ${this.traceFailure}`,
        true,
      );
      return { status: "settled" };
    }

    const verdict = await this.options.workspace.verifyScoutWorkspace(
      scout.workspaceStateHash,
      this.record.cwd,
    );
    if (!verdict.ok) {
      await this.markFinalFailure("verify", verdict.reason, true);
      return { status: "settled" };
    }

    // A launch/setup failure already carries its more precise reason. Workspace immutability still
    // ran above, but it must not rewrite that failure into a successful canary.
    if (scout.terminalState === "failed") return { status: "settled" };

    const verifiedAt = new Date().toISOString();
    scout.canary = { status: "verified", verifiedAt };
    await this.effects.appendEvent("scout.canary.verified", {
      verifiedAt,
      workspaceStateHash: verdict.workspaceStateHash,
    }).catch(() => undefined);

    if (this.effects.stopRequested()) {
      scout.terminalState = "failed";
      await this.effects.persist().catch(() => undefined);
      return { status: "settled" };
    }
    if (scout.terminalState === "budget_exhausted") {
      await this.effects.persist().catch(() => undefined);
      return { status: "settled" };
    }
    if (exitCode !== 0 && !this.expectedSuccessfulStop) {
      await this.markFinalFailure("execute", `Cursor Scout exited with code ${exitCode}`, false);
      return { status: "settled" };
    }

    const captured = await this.requireReports().collect(scout).catch((error: unknown) => ({
      state: "invalid" as const,
      text: "",
      reason: errorMessage(error),
    }));
    await this.applyCapture(captured);
    if (captured.state !== "complete" || !("card" in captured)) {
      const detail = captured.state === "invalid"
        ? captured.reason
        : `result state is ${captured.state}`;
      await this.markFinalFailure(
        "execute",
        `Cursor Scout did not produce a valid decision card: ${detail}`,
        false,
      );
      return { status: "settled" };
    }

    scout.terminalState = "complete";
    this.card = captured.card;
    this.effects.setLatestResult(captured.text);
    this.record.latestPreview = captured.card.finding.slice(0, PREVIEW_STORAGE_LIMIT);
    this.effects.recordCompletion(1, captured.text);
    this.record.attentionState = "done";
    this.record.updatedAt = new Date().toISOString();
    this.record.meaningfulUpdatedAt = this.record.updatedAt;
    await this.effects.appendEvent("scout.report.captured", {
      reportPath: scout.reportPath,
      evidencePath: scout.evidencePath ?? null,
      tracePath: scout.tracePath ?? null,
      verdict: captured.card.verdict,
      basis: captured.card.basis,
    }).catch(() => undefined);
    await this.effects.persist().catch(() => undefined);
    return { status: "settled" };
  }

  /**
   * Record a Scout that failed while it was already live, and stop the process it left running.
   *
   * The registry tears an ordinary failed start down; a Scout's failure is a result the operator has
   * to be able to read afterwards, so the record is made durable rather than removed.
   */
  async failLive(
    phase: NonNullable<ScoutRuntimeState["launchFailure"]>["phase"],
    error: unknown,
  ): Promise<void> {
    const scout = this.record.scout;
    if (scout === undefined) return;
    this.releaseBudget();
    const failedAt = new Date().toISOString();
    const message = errorMessage(error);
    scout.canary = { status: "failed", failedAt, reason: message };
    scout.terminalState = "failed";
    scout.launchFailure = { phase, failedAt, message };
    const latestResult = `Scout failed during ${phase}: ${message}`;
    this.effects.setLatestResult(latestResult);
    this.record.latestPreview = latestResult.slice(0, PREVIEW_STORAGE_LIMIT);
    this.record.executionState = "failed";
    this.record.attentionState = "failed";
    this.record.updatedAt = failedAt;
    this.record.meaningfulUpdatedAt = failedAt;
    await this.effects.appendEvent("scout.launch.failed", {
      phase,
      message,
      reportPath: scout.reportPath,
    }).catch(() => undefined);
    await this.effects.appendEvent("scout.canary.failed", { phase, message }).catch(() => undefined);
    await this.effects.appendTranscript("Scout failed", { phase, message })
      .catch(() => undefined);
    await this.effects.persist().catch(() => undefined);
    this.effects.notifySessionUpdate();
    this.effects.kill("SIGTERM");
  }

  /**
   * Turn a Scout that never launched into a durable Fleet row.
   *
   * `register` is the registry's own session registration, taken as a callback so the record is
   * already failed when it is first persisted: a Scout that reached the catalog as `starting` and
   * was rewritten afterwards would be adoptable for the width of that window.
   */
  async preserveLaunchFailure(
    phase: NonNullable<ScoutRuntimeState["launchFailure"]>["phase"],
    error: unknown,
    register: () => Promise<void>,
  ): Promise<void> {
    const scout = this.record.scout;
    if (scout === undefined) return;
    const failedAt = new Date().toISOString();
    const message = errorMessage(error);
    scout.canary = { status: "failed", failedAt, reason: message };
    scout.terminalState = "failed";
    scout.launchFailure = { phase, failedAt, message };
    this.record.executionState = "failed";
    this.record.attentionState = "failed";
    this.record.pid = 0;
    this.record.exitCode = 1;
    this.record.updatedAt = failedAt;
    this.record.meaningfulUpdatedAt = failedAt;
    this.record.latestPreview = `Scout launch failed during ${phase}: ${message}`.slice(
      0,
      PREVIEW_STORAGE_LIMIT,
    );
    this.effects.setLatestResult(this.record.latestPreview);
    await register();
    await this.effects.appendEvent("scout.launch.failed", {
      phase,
      message,
      reportPath: scout.reportPath,
    }).catch(() => undefined);
    await this.effects.appendEvent("scout.canary.failed", { phase, message }).catch(() => undefined);
    await this.effects.appendTranscript("Scout launch failed", { phase, message })
      .catch(() => undefined);
    this.effects.notifySessionUpdate();
  }

  /**
   * Rehydrate this Scout's result from its drop box after a broker restart.
   *
   * The drop box outlives the process that wrote it, so a Scout that finished while the broker was
   * down still has a canonical report to be read back. A cutoff or a failure is never promoted by
   * that reading — the terminal state it reached is the one it keeps.
   */
  async recover(): Promise<void> {
    const scout = this.record.scout;
    const reports = this.options.reports;
    if (scout === undefined || reports === undefined) return;
    const captured = await reports.collect(scout).catch(() => undefined);
    if (captured === undefined || captured.state === "missing") return;
    let changed = scout.reportState !== captured.state;
    scout.reportState = captured.state;
    if ("text" in captured) this.effects.setLatestResult(captured.text);
    if (captured.state === "complete") {
      if ("card" in captured) this.card = captured.card;
      const verifiedHeadlessResult = scout.transport === "headless-stream-json"
        && scout.terminalState === "complete";
      const recoverableLegacyResult = scout.transport !== "headless-stream-json"
        && scout.terminalState !== "budget_exhausted"
        && scout.terminalState !== "failed";
      if (verifiedHeadlessResult || recoverableLegacyResult) {
        changed ||= scout.terminalState !== "complete"
          || this.record.executionState !== "exited"
          || this.record.attentionState !== "done";
        scout.terminalState = "complete";
        this.effects.recordCompletion(1, captured.text);
        this.record.executionState = "exited";
        this.record.attentionState = "done";
        this.record.exitCode ??= 0;
      }
    }
    if (changed) {
      this.record.updatedAt = new Date().toISOString();
      this.record.meaningfulUpdatedAt = this.record.updatedAt;
      await this.effects.persist();
    }
  }

  private appendTrace(chunk: Buffer): void {
    const scout = this.record.scout;
    const reports = this.options.reports;
    if (scout === undefined || reports === undefined || chunk.length === 0) return;
    this.traceTail = (this.traceTail ?? Promise.resolve())
      .then(() => reports.appendTrace(scout, chunk))
      .catch(async (error: unknown) => {
        this.traceFailure = errorMessage(error);
        this.effects.setLatestResultIfAbsent(
          `Scout trace persistence failed: ${this.traceFailure}`,
        );
        await this.effects.persist().catch(() => undefined);
      });
  }

  private captureReport(replay: () => string): void {
    const scout = this.record.scout;
    const reports = this.options.reports;
    if (
      scout === undefined
      || scout.terminalState === "complete"
      || scout.terminalState === "failed"
      || scout.terminalState === "budget_exhausted"
      || this.cutoffStarted
      || reports === undefined
    ) return;
    const frozen = { ...scout, canary: { ...scout.canary } };
    const capture = reports.capture.bind(reports);
    const text = replay();
    this.captureTail = (this.captureTail ?? Promise.resolve())
      .then(async () => {
        const result = await capture(frozen, text);
        await this.applyCapture(result);
      })
      .catch(async (error: unknown) => {
        const current = this.record.scout;
        if (current === undefined) return;
        if (current.reportState === "complete") return;
        current.reportState = "invalid";
        this.effects.setLatestResult(errorMessage(error));
        await this.effects.persist().catch(() => undefined);
        this.effects.notifySessionUpdate();
      });
  }

  /**
   * Fold one drop-box reading into the record, and stop a Scout that has already answered.
   *
   * The SIGTERM is one-shot by construction: a valid card means the probe is done, and asking twice
   * would signal a handle that a resume may have already replaced.
   */
  private async applyCapture(result: ScoutReportCapture): Promise<void> {
    const scout = this.record.scout;
    if (scout === undefined || scout.terminalState === "complete" || result.state === "missing") {
      return;
    }
    const changed = scout.reportState !== result.state;
    scout.reportState = result.state;
    if ("text" in result && result.text !== "") this.effects.setLatestResult(result.text);
    if (result.state === "complete" && "card" in result) this.card = result.card;
    if (scout.terminalState === "budget_exhausted") {
      if (changed) await this.effects.persist();
      this.effects.notifySessionUpdate();
      return;
    }
    if (changed || result.state === "complete") await this.effects.persist();
    this.effects.notifySessionUpdate();
    if (
      result.state === "complete"
      && "card" in result
      && !this.finalizing
      && !this.acceptedCardStopRequested
    ) {
      this.acceptedCardStopRequested = true;
      this.expectedSuccessfulStop = true;
      this.effects.kill("SIGTERM");
    }
  }

  /**
   * The wall clock ran out.
   *
   * A Scout that already has a valid card is not cut off — it is stopped as a success, because the
   * probe answered before the clock did. Otherwise the cutoff is made durable *before* the process
   * is signalled, so nothing the provider emits on its way out can promote this terminal result.
   */
  private async exhaustBudget(dimension: "time", observed: number): Promise<void> {
    const scout = this.record.scout;
    if (scout === undefined || scout.terminalState !== undefined || this.exhaustingBudget) return;
    this.exhaustingBudget = true;
    this.cutoffStarted = true;
    this.budgetActive = false;
    if (this.budgetTimer !== undefined) clearTimeout(this.budgetTimer);
    delete this.budgetTimer;
    await this.captureTail?.catch(() => undefined);
    if (scout.reportState === "complete" && this.card !== undefined) {
      this.expectedSuccessfulStop = true;
      if (!this.acceptedCardStopRequested) {
        this.acceptedCardStopRequested = true;
        this.effects.kill("SIGTERM");
      }
      this.exhaustingBudget = false;
      this.effects.notifySessionUpdate();
      return;
    }
    scout.terminalState = "budget_exhausted";
    this.record.executionState = "cancelled";
    this.record.attentionState = "stopped";
    this.record.updatedAt = new Date().toISOString();
    this.record.meaningfulUpdatedAt = this.record.updatedAt;
    try {
      // Persist cutoff before stopping provider. Later output cannot promote this terminal result.
      await this.effects.persist();
      this.effects.kill("SIGTERM");
      await this.effects.appendEvent("scout.budget.exhausted", {
        dimension,
        observed,
        reportState: scout.reportState,
        reportPath: scout.reportPath,
      });
      await this.effects.appendTranscript(
        "Scout budget exhausted",
        { dimension, observed, reportState: scout.reportState },
      );
    } catch (error) {
      // A persistence failure must not leave an over-budget provider running indefinitely.
      this.effects.kill("SIGTERM");
      throw error;
    } finally {
      this.exhaustingBudget = false;
      this.effects.notifySessionUpdate();
    }
  }

  private async markFinalFailure(
    phase: "execute" | "verify",
    message: string,
    canaryFailed: boolean,
  ): Promise<void> {
    const scout = this.record.scout;
    if (scout === undefined) return;
    const failedAt = new Date().toISOString();
    scout.terminalState = "failed";
    scout.launchFailure = { phase, failedAt, message };
    if (canaryFailed) {
      scout.canary = { status: "failed", failedAt, reason: message };
      await this.effects.appendEvent("scout.canary.failed", { phase, message })
        .catch(() => undefined);
    }
    const latestResult = `Scout failed during ${phase}: ${message}`;
    this.effects.setLatestResult(latestResult);
    this.record.latestPreview = latestResult.slice(0, PREVIEW_STORAGE_LIMIT);
    this.record.executionState = "failed";
    this.record.attentionState = "failed";
    this.record.updatedAt = failedAt;
    this.record.meaningfulUpdatedAt = failedAt;
    await this.effects.appendEvent("scout.run.failed", {
      phase,
      message,
      reportPath: scout.reportPath,
    }).catch(() => undefined);
    await this.effects.appendTranscript("Scout failed", { phase, message })
      .catch(() => undefined);
    await this.effects.persist().catch(() => undefined);
    this.effects.notifySessionUpdate();
  }

  private requireState(): ScoutRuntimeState {
    const scout = this.record.scout;
    if (scout === undefined) {
      throw new ScoutSupervisionError(
        "SCOUT_REPORT_STORE_UNAVAILABLE",
        "Scout profile requires broker-owned drop-box storage",
      );
    }
    return scout;
  }

  private requireReports(): ScoutReportPort {
    const reports = this.options.reports;
    if (reports === undefined) {
      throw new ScoutSupervisionError(
        "SCOUT_REPORT_STORE_UNAVAILABLE",
        "Scout profile requires broker-owned drop-box storage",
      );
    }
    return reports;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
