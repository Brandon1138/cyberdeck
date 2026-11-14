import { StrigoiAdoptionSchema, type StrigoiIdentity, type StrigoiPacketRef } from "../domain/strigoi.js";
import type { ThreadEvent } from "../domain/thread.js";
import type { WorkerTruth } from "../domain/worker-truth.js";
import type { ThreadTranscriptReader } from "./persistence-ports.js";
import type { SessionInstructionPort, LaunchAdmission } from "./session/session-ports.js";
import { InstructionRefusedError } from "./session/session-registry-ports.js";
import type { WorkerTurnTranscriptPort } from "./session/worker-turn-ports.js";
import type { StrigoiSuccessionTurns } from "./strigoi-ports.js";

/** Native instruction/semantic-receipt adapter. No terminal scrape can establish adoption. */
export class StrigoiTurns implements StrigoiSuccessionTurns {
  constructor(private readonly registry: Pick<SessionInstructionPort, "get" | "submitInstruction"> & { workerTruth(id: string): WorkerTruth },
    private readonly transcripts: ThreadTranscriptReader & WorkerTurnTranscriptPort,
    private readonly prompt: (kind: "checkpoint" | "adoption", identity: StrigoiIdentity, packet?: StrigoiPacketRef) => Promise<string>) {}

  async boundary(identity: StrigoiIdentity): Promise<"safe" | "busy" | "modal" | "unknown"> {
    const record = this.registry.get(identity.sessionId);
    if (record.generation !== identity.generation) return "unknown";
    if (record.attachmentState === "controlled") return "busy";
    const truth = this.registry.workerTruth(identity.sessionId);
    if (truth.modalOpen) return "modal";
    return truth.state === "idle" ? "safe" : truth.state === "working" || truth.state === "stalled" ? "busy" : "unknown";
  }

  async submit(id: string, identity: StrigoiIdentity, kind: "checkpoint" | "adoption", packet: StrigoiPacketRef | undefined, admit: LaunchAdmission): Promise<void> {
    if (this.registry.get(identity.sessionId).generation !== identity.generation) throw new Error("STRIGOI_STALE_INCARNATION");
    if ((await this.events(identity.sessionId)).some((e) => e.data.instructionId === id)) return;
    const message = await this.prompt(kind, identity, packet);
    // Intent survives a crash before, during or after rendering. Absence of a rendered receipt
    // after this append cannot prove that bytes were not sent. Succession only observes it.
    await this.transcripts.append({ sessionId: identity.sessionId, kind: "instruction", source: "broker", text: message,
      data: { instructionId: id, instructionState: "queued", successionKind: kind, generation: identity.generation } });
    try {
      const result = await this.registry.submitInstruction(identity.sessionId, message, "broker", { successionKind: kind, generation: identity.generation }, id,
        (apply) => admit(async () => apply()));
      if (result.state === "rendered") return;
    } catch (error) {
      // A code/message alone cannot prove refusal: transport or persistence can fail
      // after writing. Only the production pre-write guards carry this evidence.
      if (!(error instanceof InstructionRefusedError)) throw error;
    }
    await this.transcripts.append({ sessionId: identity.sessionId, kind: "instruction", source: "broker",
      data: { instructionId: id, generation: identity.generation, successionOutcome: "terminated", instructionState: "undelivered" } });
  }

  async observe(id: string, identity: StrigoiIdentity): ReturnType<StrigoiSuccessionTurns["observe"]> {
    const events = await this.events(identity.sessionId);
    const intent = events.find((e) => e.data.instructionId === id && e.data.generation === identity.generation);
    if (!intent) return { outcome: "unknown" };
    if (events.some((e) => e.data.instructionId === id && e.data.generation === identity.generation && e.data.successionOutcome === "terminated")) return { outcome: "terminated" };
    const rendered = events.find((e) => e.data.instructionId === id && e.data.instructionState === "rendered");
    if (!rendered) return { outcome: "unknown" }; // queued or ambiguous is not permission to retype
    const receipt = events.find((e) => e.kind === "turn" && e.data.turnNumber === rendered.data.expectedTurn && e.data.transport === "provider-native");
    if (!receipt) return { outcome: "unknown" };
    if (receipt.data.outcome === "cancelled") return { outcome: "terminated" };
    let result: unknown;
    try { result = JSON.parse((receipt.text ?? "").trim().replace(/^```(?:json)?\s*\n?|\n?```$/g, "")); }
    catch { return { outcome: "completed" }; } // Core records malformed completion as an explicit hold.
    if (intent.data.successionKind === "checkpoint") {
      return { outcome: "completed", ...(typeof result === "object" && result !== null && "checkpoint" in result && typeof result.checkpoint === "string" ? { checkpoint: result.checkpoint } : {}) };
    }
    const adoption = StrigoiAdoptionSchema.safeParse(result);
    return { outcome: "completed", ...(adoption.success ? { adoption: adoption.data } : {}) };
  }

  private async events(sessionId: string): Promise<ThreadEvent[]> {
    const events: ThreadEvent[] = []; let cursor = 0;
    for (;;) {
      const page = await this.transcripts.read(sessionId, cursor, 100);
      if (page.fragment || page.continuation) throw new Error("STRIGOI_TURN_EVIDENCE_REQUIRES_PAGED_READER");
      events.push(...page.events);
      if (page.nextCursor <= cursor || page.events.length === 0) return events;
      cursor = page.nextCursor;
    }
  }
}
