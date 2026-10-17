import { createHash } from "node:crypto";
import { ATTENTION_LIMITS, type AttentionCoverage, type OrchestratorAttention } from "../domain/orchestrator-attention.js";
import type { SessionRecord } from "../domain/session.js";
import type { StoredWorkerEvent } from "../domain/worker-coordination.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import type { WorkerCoordinationService } from "../broker/worker-coordination.js";
import type { WorkerTurnLedger, WorkerTurnTranscript } from "./session/worker-turn-ports.js";

export interface AttentionSourceOptions {
  registry: { get(sessionId: string): SessionRecord; workerTruth(sessionId: string): WorkerTruth };
  coordination: Pick<WorkerCoordinationService, "getSubject" | "workerEventSummary" | "projectEvents">;
  transcripts: { readCompletionLedger(sessionId: string): Promise<WorkerTurnLedger> };
}

export interface AttentionWorkerView {
  sessionId: string; completionTarget: number;
  supervision: "held" | "lost" | "worker-missing";
  truth?: WorkerTruth;
  reports: Array<Pick<StoredWorkerEvent, "eventId" | "ordinal" | "workerId" | "kind" | "severity"
    | "interventionRequired" | "summary" | "continuation" | "state">>;
  completion?: { turn: number; text: string; data?: Record<string, unknown> };
  completionUnavailable: boolean;
  moreReports: boolean;
}

export interface AttentionSourceSnapshot {
  captured: AttentionCoverage;
  received: AttentionCoverage;
  workers: AttentionWorkerView[];
  gaps: OrchestratorAttention["gaps"];
  snapshotId: string;
  signals: Array<{ sessionId: string; intervention: boolean; blocked: boolean; backlog: boolean }>;
}

export function attentionDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Non-consuming projections only. Never call a wait, result delivery, or acknowledgement here. */
export async function captureAttentionSources(
  options: AttentionSourceOptions, record: OrchestratorAttention, maxResultChars = 1_200,
): Promise<AttentionSourceSnapshot> {
  const captured: AttentionCoverage = [];
  const received: AttentionCoverage = [];
  const workers: AttentionWorkerView[] = [];
  const gaps: OrchestratorAttention["gaps"] = [];
  const signals: AttentionSourceSnapshot["signals"] = [];
  let reportBudget: number = ATTENTION_LIMITS.reports;
  for (const target of record.statement.targets) {
    const consumed = record.coverage.consumed.find((point) => point.sessionId === target.sessionId);
    const prior = record.coverage.captured.find((point) => point.sessionId === target.sessionId);
    const authority = record.authorities.find((entry) => entry.sessionId === target.sessionId)!;
    const ledger = await options.transcripts.readCompletionLedger(target.sessionId);
    const subject = options.coordination.getSubject(target.sessionId);
    let truth: WorkerTruth | undefined;
    let missing = false;
    try { options.registry.get(target.sessionId); truth = options.registry.workerTruth(target.sessionId); }
    catch (error) {
      if ((error as { code?: string }).code !== "SESSION_NOT_FOUND") throw error;
      missing = true;
    }
    const supervision = missing ? "worker-missing" : subject?.lease.state === "active"
      && subject.lease.controller?.controllerId === record.controllerId
      && subject.lease.version === authority.leaseVersion ? "held" : "lost";
    if (supervision !== "held") gaps.push({ sessionId: target.sessionId,
      reason: supervision === "lost" ? "supervision-lost" : "worker-missing" });
    const completion = ledger.turns.find((turn) => turn.data?.turnNumber === target.completionTarget);
    const completionTurn = Math.max(prior?.completionTurn ?? 0,
      ledger.completedTurns >= target.completionTarget ? target.completionTarget : 0);
    const completionUnavailable = completionTurn > (consumed?.completionTurn ?? 0) && completion === undefined;
    if (completionUnavailable) gaps.push({ sessionId: target.sessionId, reason: "completion-unavailable" });
    const reports = supervision === "held" && reportBudget > 0 ? options.coordination.projectEvents({
      cursor: consumed?.eventOrdinal ?? 0, limit: reportBudget,
      filter: { workerIds: [target.sessionId], intervention: "any" },
    }).events : [];
    reportBudget -= reports.length;
    const eventOrdinal = Math.max(prior?.eventOrdinal ?? consumed?.eventOrdinal ?? 0,
      supervision === "held" ? options.coordination.workerEventSummary(target.sessionId).lastOrdinal : 0);
    // The bounded read page is not the policy's history. Scan metadata beyond it, conservatively
    // surfacing an oversized unresolved backlog rather than hiding an intervention behind progress.
    let cursor = consumed?.eventOrdinal ?? 0, intervention = false, blocked = false;
    for (let pageNumber = 0; supervision === "held" && cursor < eventOrdinal && pageNumber < 20; pageNumber += 1) {
      const page = options.coordination.projectEvents({ cursor, limit: 50,
        filter: { workerIds: [target.sessionId], intervention: "any" } }).events;
      if (page.length === 0) { cursor = eventOrdinal; break; }
      for (const event of page) if (event.state === "active") {
        intervention ||= event.interventionRequired || event.kind === "DECISION_REQUEST";
        blocked ||= event.continuation !== "continuing";
      }
      cursor = page.at(-1)!.ordinal;
    }
    signals.push({ sessionId: target.sessionId, intervention, blocked, backlog: supervision === "held" && cursor < eventOrdinal });
    const truthKey = attentionDigest({ supervision, state: truth?.state, terminal: truth?.terminal,
      completedTurns: truth?.completedTurns, pendingInstructions: truth?.pendingInstructions,
      modal: truth?.modal?.fingerprint, providerLimit: truth?.providerLimit });
    captured.push({ sessionId: target.sessionId, eventOrdinal, completionTurn, truthKey });
    const receivedOrdinal = reports.at(-1)?.ordinal ?? consumed?.eventOrdinal ?? 0;
    const view: AttentionWorkerView = { ...target, supervision,
      ...(truth === undefined ? {} : { truth: { ...truth, detail: truth.detail.slice(0, ATTENTION_LIMITS.textChars) } }),
      reports: reports.map((event) => ({ eventId: event.eventId, ordinal: event.ordinal, workerId: event.workerId,
        kind: event.kind, severity: event.severity, interventionRequired: event.interventionRequired,
        summary: event.summary.slice(0, 512), continuation: event.continuation, state: event.state })),
      completionUnavailable, moreReports: eventOrdinal > receivedOrdinal,
      ...(completion === undefined || completionTurn <= (consumed?.completionTurn ?? 0) ? {}
        : { completion: boundedCompletion(completion, target.completionTarget, maxResultChars) }),
    };
    workers.push(view);
    received.push({ sessionId: target.sessionId, eventOrdinal: receivedOrdinal,
      completionTurn: view.completion === undefined ? consumed?.completionTurn ?? 0 : completionTurn, truthKey });
  }
  return { captured, received, workers, gaps, signals,
    snapshotId: attentionDigest({ epoch: record.epoch, captured, gaps, signals }) };
}

function boundedCompletion(turn: WorkerTurnTranscript, number: number, maxChars: number): NonNullable<AttentionWorkerView["completion"]> {
  // Expose only receipt identity/outcome fields; provider-authored arbitrary data stays in its journal.
  const data = turn.data === undefined ? undefined : Object.fromEntries(
    ["semanticTurnId", "transport", "outcome", "provider", "providerTurnId"]
      .filter((key) => turn.data?.[key] !== undefined).map((key) => [key, turn.data![key]]),
  );
  return { turn: number, text: (turn.text ?? "").slice(0, maxChars), ...(data === undefined ? {} : { data }) };
}
