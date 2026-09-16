import type { InstructionLifecycleState, WorkerTruth } from "../domain/worker-truth.js";

/** Broker-owned canonical facts; unknown tool/report/settlement state fails closed. */
export interface ParkingSnapshot {
  sessionId: string;
  generation: number;
  executionId: string;
  workspaceId: string;
  conversationId: string | null;
  /** Opaque canonical controller/lease epoch. This service never derives controller identities. */
  authorityEpoch: string;
  /** Changes for input, attachment, tool/report and turn-settlement activity. */
  revision: number;
  runtime: "running" | "stopped" | "unknown";
  truth: WorkerTruth;
  instructions: InstructionLifecycleState[];
  settled: boolean | null;
  outstandingTools: number | null;
  pendingReports: number | null;
  operatorAttached: boolean;
  resumeSupported: boolean;
}
export interface ParkingClaim { token: string; expected: ParkingSnapshot }
export interface RuntimeParkingPort {
  snapshot(sessionId: string): ParkingSnapshot;
  /** Synchronous CAS over ALL snapshot facts; fences delivery/attachment before returning.
   * New input remains in the existing durable queue and calls inputQueued synchronously.
   * Handoff/generation replacement invalidates the claim without transferring authority. */
  claim(expected: ParkingSnapshot): ParkingClaim | undefined;
  release(claim: ParkingClaim): void;
  /** Restore the durable input fence after restart, only on an exact already-stopped runtime. */
  restoreParked(expected: ParkingSnapshot): boolean;
  /** Ordinary graceful stop, fenced to the claim's exact runtime/generation. No SIGSTOP. */
  stop(claim: ParkingClaim): Promise<void>;
  /** Provider exit AND canonical terminal settlement; never a claim of guest/tree cleanup. */
  awaitStopped(claim: ParkingClaim): Promise<"stopped" | "unknown" | "superseded">;
  /** Existing ordinary resume through the common admitted start gate, never a direct factory.
   * Revalidate claim authority immediately before launch and retain ordinary generation fencing. */
  resume(claim: ParkingClaim): Promise<ParkingSnapshot>;
  /** Only asks the existing durable instruction queue to flush; no message construction/replay. */
  flush(sessionId: string): Promise<void>;
}
export interface ParkingRecord {
  sessionId: string;
  identity: Pick<ParkingSnapshot, "generation" | "executionId" | "workspaceId" | "conversationId" | "authorityEpoch">;
  phase: "parking" | "parked" | "waking" | "active" | "intervention";
  wakeAttempts: number;
  reason: string | null;
}
export interface ParkingStore {
  get(sessionId: string): ParkingRecord | undefined;
  /** Durable before resolving. Implementations must not expose a failed write as committed. */
  put(record: ParkingRecord): Promise<void>;
}
export type ParkingResult = { state: "active" | "parked" | "skipped" | "intervention"; reason?: string };
const terminalInstructions = new Set<InstructionLifecycleState>(["completed", "cancelled", "undelivered"]);
export function parkingRefusal(snapshot: ParkingSnapshot): string | undefined {
  if (snapshot.runtime !== "running") return "runtime-not-running";
  if (!snapshot.resumeSupported || !snapshot.conversationId) return "resume-unavailable";
  if (snapshot.operatorAttached) return "operator-attached";
  if (snapshot.truth.state !== "idle" || snapshot.truth.terminal || snapshot.truth.modalOpen || snapshot.truth.composerOccupied)
    return "provider-not-quiescent";
  if (snapshot.settled !== true || snapshot.truth.canonicalTurns < 1) return "canonical-turn-unsettled";
  if (snapshot.truth.pendingInstructions !== 0 || snapshot.instructions.some(status => !terminalInstructions.has(status))) return "pending-input";
  if (snapshot.outstandingTools !== 0) return "pending-or-unknown-tools";
  if (snapshot.pendingReports !== 0) return "pending-or-unknown-reports";
  return undefined;
}
function identity(snapshot: ParkingSnapshot): ParkingRecord["identity"] {
  const { generation, executionId, workspaceId, conversationId, authorityEpoch } = snapshot;
  return { generation, executionId, workspaceId, conversationId, authorityEpoch };
}
function sameRuntime(left: ParkingRecord["identity"], right: ParkingSnapshot): boolean {
  return left.generation === right.generation && left.executionId === right.executionId
    && left.workspaceId === right.workspaceId && left.conversationId === right.conversationId;
}

/** Idle-runtime policy only. Resource accounting/release remains owned by the common start gate.
 * Install ONE instance at broker composition and route every input/attachment path through its port. */
export class RuntimeParkingService {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly idle = new Map<string, { identity: string; revision: number; since: number }>();
  private readonly wakeRequested = new Set<string>();
  constructor(private readonly port: RuntimeParkingPort, private readonly store: ParkingStore,
    private readonly options: { idleGraceMs: number; maxWakeAttempts?: number; now?: () => number }) {
    if (!Number.isSafeInteger(options.idleGraceMs) || options.idleGraceMs < 0 || options.idleGraceMs > 86400000
      || !Number.isSafeInteger(options.maxWakeAttempts ?? 1) || (options.maxWakeAttempts ?? 1) < 1 || (options.maxWakeAttempts ?? 1) > 3)
      throw new Error("invalid-parking-policy");
  }
  /** Call synchronously when accepting durable input, before any await or attempted delivery. */
  inputQueued(sessionId: string): Promise<ParkingResult> {
    this.wakeRequested.add(sessionId); this.idle.delete(sessionId);
    return this.wake(sessionId);
  }
  consider(sessionId: string): Promise<ParkingResult> {
    return this.serialize(sessionId, () => this.park(sessionId));
  }
  wake(sessionId: string): Promise<ParkingResult> {
    return this.serialize(sessionId, () => this.wakeCurrent(sessionId));
  }
  /** Retirement removes volatile clocks only; durable work/evidence retention stays with composition. */
  forget(sessionId: string): void {
    if (this.tails.has(sessionId)) throw new Error("parking-transition-pending");
    this.idle.delete(sessionId); this.wakeRequested.delete(sessionId);
  }
  /** Restart reconciles recorded intent with exact current identity; it never invents cleanup. */
  recover(sessionId: string): Promise<ParkingResult> {
    return this.serialize(sessionId, async () => {
      const record = this.store.get(sessionId);
      if (!record || record.phase === "active") return { state: "active" };
      const current = this.port.snapshot(sessionId);
      if (!sameRuntime(record.identity, current)) {
        if (record.phase === "waking" && this.isResumed(record, current)) {
          await this.store.put({ ...record, identity: identity(current), phase: "active", reason: null });
          await this.port.flush(sessionId); return { state: "active" };
        }
        return this.intervene(record, "runtime-replaced");
      }
      if (current.runtime !== "stopped") return this.intervene(record, "stop-not-confirmed");
      if (!this.port.restoreParked(current)) return this.intervene(record, "snapshot-changed");
      await this.store.put({ ...record, phase: "parked", reason: null });
      if (current.instructions.some(status => !terminalInstructions.has(status)) || this.wakeRequested.has(sessionId))
        return this.wakeCurrent(sessionId);
      return { state: "parked" };
    });
  }
  private async park(sessionId: string): Promise<ParkingResult> {
    const before = this.port.snapshot(sessionId);
    const refused = parkingRefusal(before);
    if (refused || this.wakeRequested.has(sessionId)) {
      this.idle.delete(sessionId); return { state: "skipped", reason: refused ?? "wake-requested" };
    }
    const stamp = JSON.stringify(identity(before));
    const now = this.options.now?.() ?? Date.now();
    let idle = this.idle.get(sessionId);
    if (!idle || idle.identity !== stamp || idle.revision !== before.revision || now < idle.since) {
      idle = { identity: stamp, revision: before.revision, since: now }; this.idle.set(sessionId, idle);
    }
    if (now - idle.since < this.options.idleGraceMs) return { state: "skipped", reason: "idle-grace" };
    const claim = this.port.claim(before);
    if (!claim) { this.idle.delete(sessionId); return { state: "skipped", reason: "snapshot-changed" }; }
    const record: ParkingRecord = { sessionId, identity: identity(before), phase: "parking", wakeAttempts: 0, reason: null };
    try {
      await this.store.put(record);
      const latest = this.port.snapshot(sessionId);
      if (!sameRuntime(record.identity, latest) || latest.authorityEpoch !== before.authorityEpoch)
        return await this.intervene(record, "authority-or-generation-changed");
      const changed = parkingRefusal(latest);
      if (changed || this.wakeRequested.has(sessionId)) {
        await this.store.put({ ...record, phase: "active", reason: null });
        return { state: "skipped", reason: changed ?? "input-arrived" };
      }
      // stop must synchronously fence the exact claim before its first asynchronous boundary.
      await this.port.stop(claim);
      const outcome = await this.port.awaitStopped(claim);
      if (outcome !== "stopped") return await this.intervene(record, `stop-${outcome}`);
      const stopped = this.port.snapshot(sessionId);
      if (!sameRuntime(record.identity, stopped) || stopped.runtime !== "stopped")
        return await this.intervene(record, "runtime-replaced");
      await this.store.put({ ...record, phase: "parked", reason: null });
      this.idle.delete(sessionId);
      return { state: "parked" };
    } catch {
      return await this.intervene(record, "parking-failed");
    } finally { this.port.release(claim); }
  }
  private async wakeCurrent(sessionId: string): Promise<ParkingResult> {
    const record = this.store.get(sessionId);
    const current = this.port.snapshot(sessionId);
    if (!record || record.phase === "active") {
      this.wakeRequested.delete(sessionId);
      if (current.runtime === "running") await this.port.flush(sessionId);
      return { state: "active" };
    }
    if (!sameRuntime(record.identity, current)) return this.intervene(record, "runtime-replaced");
    if (record.phase !== "parked" || current.runtime !== "stopped") return this.intervene(record, "not-safely-parked");
    if (!current.resumeSupported || !current.conversationId) return this.intervene(record, "resume-unavailable");
    if (record.wakeAttempts >= (this.options.maxWakeAttempts ?? 1)) return this.intervene(record, "wake-attempt-limit");
    // Handoff may change authority while parked. Use the CURRENT canonical epoch, never the old holder.
    const claim = this.port.claim(current);
    if (!claim) return { state: "skipped", reason: "snapshot-changed" };
    const waking: ParkingRecord = { ...record, identity: identity(current), phase: "waking", wakeAttempts: record.wakeAttempts + 1, reason: null };
    try {
      await this.store.put(waking);
      const latest = this.port.snapshot(sessionId);
      if (!sameRuntime(waking.identity, latest) || latest.authorityEpoch !== current.authorityEpoch)
        return await this.intervene(waking, "authority-or-generation-changed");
      const resumed = await this.port.resume(claim);
      if (!this.isResumed(waking, resumed)) return await this.intervene(waking, "resume-identity-mismatch");
      await this.store.put({ ...waking, identity: identity(resumed), phase: "active", reason: null });
      this.wakeRequested.delete(sessionId);
    } catch {
      // Resume can succeed before active-state persistence fails. Keep its original waking
      // identity so recovery recognizes generation +1 instead of launching another provider.
      if (this.isResumed(waking, this.port.snapshot(sessionId))) {
        await this.store.put({ ...waking, reason: "wake-settlement-failed" });
        return { state: "intervention", reason: "wake-settlement-failed" };
      }
      return await this.intervene(waking, "resume-failed");
    } finally { this.port.release(claim); }
    await this.port.flush(sessionId);
    return { state: "active" };
  }
  private isResumed(record: ParkingRecord, current: ParkingSnapshot): boolean {
    return current.sessionId === record.sessionId && current.runtime === "running" && current.generation === record.identity.generation + 1
      && current.workspaceId === record.identity.workspaceId && current.conversationId === record.identity.conversationId
      && current.authorityEpoch === record.identity.authorityEpoch;
  }
  private async intervene(record: ParkingRecord, reason: string): Promise<ParkingResult> {
    await this.store.put({ ...record, phase: "intervention", reason });
    return { state: "intervention", reason };
  }
  private serialize<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.tails.set(sessionId, next);
    return next.finally(() => { if (this.tails.get(sessionId) === next) this.tails.delete(sessionId); });
  }
}
