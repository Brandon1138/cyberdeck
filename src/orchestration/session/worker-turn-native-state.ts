import type { SessionRecord } from "../../domain/session.js";
import type { CaptureWorkerTurns, ProviderTerminalActivity, WorkerTurnObservation } from "./worker-turn-ports.js";
import { projectWorkerTruth, type WorkerTruth } from "../../domain/worker-truth.js";
import { StringDecoder } from "node:string_decoder";

/** Carry the durable launch identity on every live and recovery source read. */
export function nativeTurnIdentity(record: SessionRecord): Omit<CaptureWorkerTurns, "turnNumber" | "fallbackText" | "allowFallback"> {
  return { sessionId: record.id, provider: record.provider, cwd: record.cwd, createdAt: record.createdAt,
    initialInstructionId: record.initialInstructionId, codexMarkerRequired: record.codexActorMarker === true };
}

export function pendingExitTruth(completedTurns: number, canonicalTurns: number, pendingInstructions: number): WorkerTruth {
  return { ...projectWorkerTruth({ executionState: "active", exitCode: null, activity: "unknown",
    composer: { modalOpen: false, occupied: false }, completedTurns, canonicalTurns, pendingInstructions,
  }), detail: "Provider process exited; final completion evidence is being settled" };
}

/** Exactly bound native activity, fenced against newer screen/input and process generations. */
export class NativeTurnActivity {
  available = false;
  refused = false;
  private view?: { activity: ProviderTerminalActivity; revision: number; current: boolean };
  private seenEvidence?: string;
  private readonly closedNativeIds = new Set<string>();
  private screenRevision = -1;
  private lastWorkingAt = 0;
  private inputAt?: string;
  private generationStartedAt: string;
  private resumed = false;
  private stream = "";
  private streamDecoder = new StringDecoder("utf8");
  private streamActivity: ProviderTerminalActivity = "unknown";

  constructor(createdAt: string) { this.generationStartedAt = createdAt; }

  reset(startedAt: string): void {
    this.available = false; this.refused = false;
    delete this.view;
    delete this.seenEvidence;
    delete this.inputAt;
    this.screenRevision = -1; this.lastWorkingAt = 0;
    this.generationStartedAt = startedAt;
    this.resumed = true;
    this.stream = "";
    this.streamDecoder = new StringDecoder("utf8");
    this.streamActivity = "unknown";
  }

  noteInput(at: string): void { this.inputAt = at; delete this.view; this.screenRevision = -1; }
  admit(revision: number): void {
    // An admission fence is not provider input. Preserve the already known idle boundary while
    // preflight drains historical receipts; actual bytes invalidate it through noteInput.
    if (this.view?.revision === revision - 1 && this.view.activity === "awaiting-input") this.view.revision = revision;
    if (this.screenRevision === revision - 1 && this.inputAt === undefined && this.lastWorkingAt === 0) this.screenRevision = revision;
  }
  committed(turns: readonly { data?: Record<string, unknown> | undefined }[]): void {
    for (const turn of turns) {
      if (turn.data?.transport !== "provider-native") continue;
      if (typeof turn.data.semanticTurnId === "string") this.closedNativeIds.add(turn.data.semanticTurnId);
      if (typeof turn.data.nativeActivityId === "string") this.closedNativeIds.add(`activity:${turn.data.nativeActivityId}`);
    }
    while (this.closedNativeIds.size > 100_000) this.closedNativeIds.delete(this.closedNativeIds.values().next().value!);
  }
  observeScreen(revision: number, activity: ProviderTerminalActivity = "unknown", at = Date.now()): void {
    this.screenRevision = revision;
    if (activity === "working") this.lastWorkingAt = at;
  }
  ownsCurrentEnd(revision: number): boolean {
    return this.view?.revision === revision && this.view.current && this.view.activity === "awaiting-input";
  }

  turns(observation: WorkerTurnObservation, revision: number,
    rendered: readonly { expectedTurn: number; renderedAt: string }[] = []): WorkerTurnObservation["turns"] {
    const turns = observation.turns;
    if (observation.nativeSourceAvailable !== true) return turns;
    const seen = new Set<string>();
    let accepted = 0;
    return turns.filter(turn => {
      const id = `${observation.provider}:${turn.providerTurnId}`;
      if (seen.has(id) || this.closedNativeIds.has(id)
        || (typeof turn.data?.nativeActivityId === "string" && this.closedNativeIds.has(`activity:${turn.data.nativeActivityId}`))) return false;
      seen.add(id);
      const input = rendered.find(entry => entry.expectedTurn === observation.turnNumber + accepted);
      // Native writes can lag preflight. A late older receipt never owns a newer rendered input;
      // leave it unassigned until a current receipt or a later recovery can account for history.
      if (turn.transport === "provider-native" && input !== undefined
        && (turn.data?.nativeTimestampKnown === false || observation.nativeActivityEvidence?.occurredAt === undefined || !Number.isFinite(Date.parse(turn.providerOccurredAt))
          || Date.parse(turn.providerOccurredAt) < Date.parse(input.renderedAt))) return false;
      accepted += 1;
      return true;
    });
  }

  /** The declared one-shot Cursor JSON transport has native progress, never a terminal composer. */
  observeHeadless(chunk: Buffer): ProviderTerminalActivity {
    this.stream += this.streamDecoder.write(chunk);
    let newline: number;
    while ((newline = this.stream.indexOf("\n")) >= 0) {
      const line = this.stream.slice(0, newline); this.stream = this.stream.slice(newline + 1);
      try {
        const frame = JSON.parse(line) as { type?: string; message?: { role?: string } };
        if (frame.type === "assistant" && frame.message?.role === "assistant") this.streamActivity = "working";
        else if (frame.type === "result") this.streamActivity = "unknown"; // Final verification belongs to Scout supervision.
      } catch { /* Unrecognized stream output proves no activity or completion. */ }
    }
    if (this.stream.length > 1024 * 1024) { this.stream = ""; this.streamActivity = "unknown"; }
    return this.streamActivity;
  }

  observe(observation: WorkerTurnObservation, captureRevision: number, currentRevision: number): boolean {
    if (observation.nativeSourceAvailable === undefined) return false;
    const before = this.activity("unknown", currentRevision);
    const previousAvailability = this.available, previousRefusal = this.refused;
    this.refused = observation.nativeSourceStatus === "unbound" || observation.nativeSourceStatus === "conflict"
      || observation.nativeSourceStatus === "source-error" || observation.nativeSourceReason === "NATIVE_COMPLETION_BOUNDARY_MISSING";
    this.available = observation.nativeSourceAvailable;
    if (!this.available) delete this.view;
    else {
      const evidence = observation.nativeActivityEvidence;
      const occurredAt = evidence?.occurredAt;
      const newEvidence = evidence !== undefined && this.seenEvidence !== evidence.id;
      if (evidence !== undefined && captureRevision === currentRevision) this.seenEvidence = evidence.id;
      const currentGeneration = evidence !== undefined && (occurredAt === undefined
        ? !this.resumed && this.inputAt === undefined && !(observation.nativeActivity === "idle" && this.lastWorkingAt > 0)
        : Number.isFinite(Date.parse(occurredAt)) && Date.parse(occurredAt) >= Math.max(
          Date.parse(this.generationStartedAt), this.inputAt === undefined ? 0 : Date.parse(this.inputAt),
          observation.nativeActivity === "idle" ? this.lastWorkingAt : 0));
      const activity = !currentGeneration ? "unknown"
        : observation.nativeActivity === "working" ? "working"
          : observation.nativeActivity === "idle" ? "awaiting-input" : "unknown";
      if (newEvidence && captureRevision === currentRevision) {
        this.view = { activity, revision: currentRevision, current: currentGeneration };
      }
    }
    return previousAvailability !== this.available || previousRefusal !== this.refused || before !== this.activity("unknown", currentRevision);
  }

  activity(screen: ProviderTerminalActivity, revision: number): ProviderTerminalActivity {
    if (this.refused) return screen === "needs-input" || screen === "working" ? screen : "unknown";
    if (screen === "needs-input" || !this.available) return screen;
    // A positively ready startup surface belongs to this process, independently of historical
    // native ends. It permits first input, without attributing old completion effects to resume.
    if (screen === "awaiting-input" && this.screenRevision === revision && this.inputAt === undefined
      && this.lastWorkingAt === 0 && (this.view === undefined || !this.view.current || this.view.activity === "unknown")) return screen;
    if (this.view?.revision === revision) return screen === "working" && (!this.view.current || this.view.activity === "unknown") ? "working" : this.view.activity;
    if (screen === "working" || (this.view?.current && this.view.activity === "working")) return "working";
    if (this.view?.current && this.view.activity === "awaiting-input"
      && screen === "awaiting-input" && this.screenRevision === revision) return screen;
    return "unknown";
  }
}

export function supportsNativeTurnObservation(record: SessionRecord, suppressed: boolean): boolean {
  return record.executionState === "active" && !suppressed && record.profile !== "scout"
    && (record.provider === "claude" || record.provider === "codex");
}

export function nativeReadFailure(record: SessionRecord, turnNumber: number): WorkerTurnObservation {
  return { sessionId: record.id, provider: record.provider, turnNumber, turns: [], nativeSourceAvailable: false,
    nativeSourceStatus: "source-error", nativeFallbackAllowed: false, nativeActivity: "unknown" };
}
