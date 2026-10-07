import { randomUUID } from "node:crypto";
import type { ParkingClaim, ParkingSnapshot, RuntimeParkingPort } from "../runtime-parking-service.js";
import type { SessionCatalog } from "./session-catalog.js";
import type { SessionLifecycleController } from "./session-lifecycle-controller.js";
import { RegistryError } from "./session-registry-ports.js";
import type { SessionUpdateBus } from "./session-update-bus.js";

export type ParkingExternalFacts = Pick<ParkingSnapshot, "authorityEpoch" | "instructions" | "outstandingTools" | "pendingReports" | "resumeSupported" | "conversationId">;
export interface SessionParkingOptions {
  /** Current canonical read models; missing tool/report evidence MUST be null, never zero. */
  facts: (sessionId: string) => ParkingExternalFacts;
  /** Synchronously latch service.inputQueued; observe its rejection outside the input hot path. */
  onInputQueued: (sessionId: string) => void;
  flush: (sessionId: string) => Promise<void>;
  stopDeadlineMs?: number;
}

/** Concrete registry CAS/input fence. Runtime lifecycle keeps ordinary stop/resume ownership. */
export class SessionParkingCoordinator implements RuntimeParkingPort {
  private readonly revisions = new Map<string, { fingerprint: string; revision: number }>();
  constructor(private readonly catalog: SessionCatalog, private readonly lifecycle: SessionLifecycleController,
    private readonly bus: SessionUpdateBus, private readonly options: SessionParkingOptions) {
    if (!catalog.options.resourceExecution) throw new Error("parking-requires-common-resource-start-gate");
    if (!Number.isSafeInteger(options.stopDeadlineMs ?? 30000) || (options.stopDeadlineMs ?? 30000) < 1
      || (options.stopDeadlineMs ?? 30000) > 60000) throw new Error("invalid-parking-stop-deadline");
  }
  snapshot(sessionId: string): ParkingSnapshot {
    if (this.revisions.size > this.catalog.sessions.size)
      for (const id of this.revisions.keys()) if (!this.catalog.sessions.has(id)) this.revisions.delete(id);
    const runtime = this.catalog.requireRuntime(sessionId);
    runtime.parkingInput = () => this.options.onInputQueued(sessionId);
    const record = runtime.record;
    const turnState = runtime.turns.parkingState();
    const facts = this.options.facts(sessionId);
    const input: Omit<ParkingSnapshot, "revision"> = { ...facts, sessionId,
      generation: record.generation ?? 1, executionId: record.execution?.executionId ?? record.id,
      workspaceId: record.execution?.workspaceId ?? record.cwd,
      runtime: record.exitCode !== null && !runtime.terminalFinalizing ? "stopped"
        : runtime.sessionRuntime && record.executionState === "active" && !runtime.stopRequested ? "running" : "unknown",
      truth: runtime.turns.projectTruth(), settled: turnState.settled && !runtime.resuming && !runtime.terminalFinalizing
        && (runtime.parkingInputOperations ?? 0) === 0,
      operatorAttached: runtime.controller !== undefined || runtime.watchers.size > 0 };
    const fingerprint = JSON.stringify([input, turnState.revision]);
    const prior = this.revisions.get(sessionId);
    const revision = prior && prior.fingerprint === fingerprint ? prior.revision : (prior?.revision ?? 0) + 1;
    this.revisions.set(sessionId, { fingerprint, revision });
    return structuredClone({ ...input, revision });
  }
  claim(expected: ParkingSnapshot): ParkingClaim | undefined {
    const runtime = this.catalog.requireRuntime(expected.sessionId);
    if (runtime.parkingClaim || JSON.stringify(this.snapshot(expected.sessionId)) !== JSON.stringify(expected)) return undefined;
    const token = randomUUID(); runtime.parkingClaim = token;
    return { token, expected: structuredClone(expected) };
  }
  release(claim: ParkingClaim): void {
    const runtime = this.catalog.sessions.get(claim.expected.sessionId);
    if (runtime?.parkingClaim === claim.token) delete runtime.parkingClaim;
  }
  restoreParked(expected: ParkingSnapshot): boolean {
    if (expected.runtime !== "stopped" || JSON.stringify(this.snapshot(expected.sessionId)) !== JSON.stringify(expected)) return false;
    this.catalog.requireRuntime(expected.sessionId).parkingStopped = true;
    return true;
  }
  async stop(claim: ParkingClaim): Promise<void> {
    const runtime = this.assertCurrent(claim);
    runtime.parkingStopped = true;
    await this.lifecycle.stop(claim.expected.sessionId, true);
  }
  awaitStopped(claim: ParkingClaim): Promise<"stopped" | "unknown" | "superseded"> {
    const read = (): "stopped" | "superseded" | undefined => {
      const current = this.snapshot(claim.expected.sessionId);
      if (current.generation !== claim.expected.generation || current.executionId !== claim.expected.executionId) return "superseded";
      return current.runtime === "stopped" ? "stopped" : undefined;
    };
    const immediate = read();
    if (immediate) return Promise.resolve(immediate);
    return new Promise(resolve => {
      let settled = false;
      const finish = (result: "stopped" | "unknown" | "superseded") => {
        if (settled) return; settled = true; clearTimeout(timer); unsubscribe(); resolve(result);
      };
      const unsubscribe = this.bus.onSessionUpdate(sessionId => {
        if (sessionId !== claim.expected.sessionId) return;
        try { const result = read(); if (result) finish(result); } catch { finish("unknown"); }
      });
      const timer = setTimeout(() => finish("unknown"), this.options.stopDeadlineMs ?? 30000);
      const result = read(); if (result) finish(result);
    });
  }
  async resume(claim: ParkingClaim): Promise<ParkingSnapshot> {
    const runtime = this.assertCurrent(claim);
    await this.lifecycle.resume(claim.expected.sessionId, claim.token, () => { this.assertCurrent(claim); });
    delete runtime.parkingStopped;
    return this.snapshot(claim.expected.sessionId);
  }
  flush(sessionId: string): Promise<void> { return this.options.flush(sessionId); }
  private assertCurrent(claim: ParkingClaim) {
    const runtime = this.catalog.requireRuntime(claim.expected.sessionId);
    const current = this.snapshot(claim.expected.sessionId);
    if (runtime.parkingClaim !== claim.token || current.generation !== claim.expected.generation
      || current.executionId !== claim.expected.executionId || current.authorityEpoch !== claim.expected.authorityEpoch)
      throw new RegistryError("SESSION_BUSY", "Parking claim was superseded");
    return runtime;
  }
}
