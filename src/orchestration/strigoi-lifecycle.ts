import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { STRIGOI_KEY, StrigoiDesiredSchema, StrigoiSelectionSchema, type StrigoiDesired, type StrigoiIdentity, type StrigoiSelection, type StrigoiState } from "../domain/strigoi.js";
import type { SessionRecord } from "../domain/session.js";
import type { OrchestratorBindingRepository } from "./persistence-ports.js";
import type { OrchestratorManager } from "./orchestrator-manager.js";
import { orchestratorLaunchBinding } from "./orchestrator-launch-policy.js";
import type { LaunchReservation, SessionLookupPort, SessionStartPort } from "./session/session-ports.js";
import type { StrigoiAdmissionPort, StrigoiInspection, StrigoiRepository } from "./strigoi-ports.js";
import { strigoiPrompt } from "./strigoi-prompt.js";

const RETRY_DELAYS = [1000, 5000, 30000] as const;
const errorCode = (error: unknown): string => typeof error === "object" && error !== null && "code" in error ? String(error.code) : "LAUNCH_FAILED";
const permanent = (code: string): boolean => /AUTH|CREDENTIAL|LOGIN|PERMISSION|APPROVAL|UNSUPPORTED|NOT_REGISTERED|INVALID|ENOENT|EACCES|CONFIG|SELECTION/.test(code);
function launchFailureCode(error: unknown, depth = 0): string {
  const code = errorCode(error);
  if (permanent(code)) return code;
  if (error instanceof Error && error.name === "ZodError") return "STRIGOI_INVALID_CONFIGURATION";
  // Provider preparation can wrap filesystem/auth errors (notably Codex Remote Control).
  if (error instanceof Error && depth < 4 && error.cause !== undefined) {
    const cause = launchFailureCode(error.cause, depth + 1);
    if (permanent(cause)) return cause;
  }
  return code;
}
const identity = (state: StrigoiState): StrigoiIdentity | undefined => state.activeBinding === undefined ? undefined
  : { sessionId: state.activeBinding.sessionId, incarnation: state.incarnation, generation: state.activeGeneration! };
const failure = (code: string): Error => Object.assign(new Error(code), { code });

export interface StrigoiLifecycleOptions {
  repository: StrigoiRepository;
  bindings: OrchestratorBindingRepository;
  admission: StrigoiAdmissionPort;
  manager: Pick<OrchestratorManager, "prepareResident" | "observeResident">;
  registry: SessionLookupPort & SessionStartPort & {
    ownsProcess(sessionId: string): boolean;
    stopResidentProcess(sessionId: string): Promise<void>;
    workerTruth(sessionId: string): { modalOpen: boolean };
  };
  onError?: (error: unknown) => void;
}

/** Passive initial residence only. Succession/adoption is deliberately a later collaborator. */
export class StrigoiLifecycle {
  private disposed = false;
  private epoch = 0;
  private pending: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: StrigoiLifecycleOptions) {}

  /** Core boot calls this before exposing the socket; no provider work is performed here. */
  async quiesce(): Promise<void> { await this.freeze(await this.options.repository.read()); }

  async configure(selection: StrigoiSelection, mutationId: string): Promise<StrigoiInspection> {
    const parsed = StrigoiSelectionSchema.parse(selection);
    if (!isAbsolute(parsed.cwd)) throw failure("INVALID_SESSION_CWD");
    await this.authority(async () => {
      const state = await this.options.repository.read();
      if (JSON.stringify(state.selection) === JSON.stringify(parsed)) return;
      if (state.activeBinding || state.transition?.successor) throw failure("STRIGOI_CONFIGURATION_IN_USE");
      await this.write(state, { selection: parsed, desired: "enabled", hold: undefined, transition: undefined }, mutationId);
    });
    return this.inspect();
  }

  async setDesired(desired: StrigoiDesired, mutationId: string): Promise<void> {
    StrigoiDesiredSchema.parse(desired);
    // Synchronous fence catches preparation/initialization that resolves while freeze drains.
    this.epoch += 1;
    this.clearTimer();
    await this.freeze(await this.options.repository.read());
    const state = await this.authority(async () => {
      const current = await this.options.repository.read();
      if (desired === "enabled" && !current.selection) throw failure("STRIGOI_NOT_CONFIGURED");
      if (current.desired === desired && (desired !== "enabled" || !current.hold)) return current;
      // An unresolved assigned identity must survive resume; clearing it would authorize duplicates.
      const transition = current.transition?.successor ? current.transition : undefined;
      return this.write(current, { desired, ...(desired === "enabled" ? { hold: undefined, transition } : {}) }, mutationId);
    });
    if (desired !== "enabled") await this.stopOwned(state);
  }

  reconcile(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    const work = this.reconcileOnce();
    this.pending = work.finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async inspect(): Promise<StrigoiInspection> {
    const state = await this.options.repository.read();
    const id = state.activeBinding?.sessionId ?? state.transition?.successor?.sessionId;
    let runtime: SessionRecord | undefined;
    if (id) { try { runtime = this.options.registry.get(id); } catch { /* Missing is not proof of death. */ } }
    const ready = runtime?.executionState === "active" && runtime.exitCode === null && runtime.generation === state.activeGeneration
      && id !== undefined && this.owned(id) && !this.options.registry.workerTruth(id).modalOpen;
    return { state, ...(runtime ? { runtime } : {}), ownership: id ? this.owned(id) ? "owned" : "unknown" : "none",
      readiness: state.hold || state.desired !== "enabled" || !state.activeBinding || !ready ? state.selection ? "held" : "unconfigured" : "passive",
      adoption: state.latestPacket || state.incarnation > 1 ? "pending" : "not-required", usage: "unknown" };
  }

  dispose(): void {
    this.disposed = true; this.epoch += 1; this.clearTimer();
    void this.quiesce().catch((error: unknown) => this.options.onError?.(error));
  }

  /** Registry-only hooks. Public start schemas cannot supply a launch reservation. */
  async validateReservation(reservation: LaunchReservation): Promise<void> {
    const state = await this.options.repository.read();
    if (this.disposed || state.desired !== "enabled" || state.transition?.id !== reservation.transitionId
      || state.transition.phase !== "launching" || state.transition.successor?.sessionId !== reservation.sessionId
      || state.activeBinding !== undefined || state.hold) throw failure("STRIGOI_RESERVATION_UNAUTHORIZED");
  }

  async beforeStop(sessionId: string): Promise<void> {
    const state = await this.options.repository.read().catch((error: unknown) => {
      if (errorCode(error) === "STRIGOI_CORRUPT_STATE") return undefined;
      throw error;
    });
    if (!state) return; // Corruption already disables launches; unrelated stop remains available.
    if ((state.activeBinding?.sessionId === sessionId || state.transition?.successor?.sessionId === sessionId) && state.desired === "enabled") {
      await this.setDesired("suspended", `stop:${randomUUID()}`);
    }
  }

  async beforeResume(sessionId: string): Promise<void> {
    if (this.options.registry.get(sessionId).kind !== "orchestrator") return;
    const binding = await this.options.bindings.findBySessionId(sessionId);
    if (binding !== undefined && binding.kind !== "resident") return;
    // Unbound ordinary workers have no resident lifecycle. Corruption must not strand them.
    if ((await this.options.repository.retentionPins()).has(sessionId)) throw failure("STRIGOI_RESUME_REQUIRES_LIFECYCLE");
  }

  private async reconcileOnce(): Promise<void> {
    const epoch = this.epoch;
    let state = await this.options.repository.read();
    if (this.disposed || state.desired !== "enabled") return;
    if (state.activeBinding) {
      if (!this.owned(state.activeBinding.sessionId)) { await this.freeze(state); await this.hold("launch-ownership-unresolved", "Recorded identity has no owned runtime; succession is not implemented in Task 4."); return; }
      const record = this.options.registry.get(state.activeBinding.sessionId);
      if (record.generation !== state.activeGeneration) { await this.freeze(state); await this.hold("launch-ownership-unresolved", "Runtime generation differs from the active binding."); return; }
      if (record.executionState !== "active" || record.exitCode !== null) { await this.freeze(state); await this.hold("provider-unavailable", "The owned runtime is not active; inspect provider evidence before recovery."); return; }
      if (this.options.registry.workerTruth(record.id).modalOpen) { await this.freeze(state); await this.hold("provider-permission-modal", "Provider requires operator input; no automatic answer or model turn."); return; }
      if (state.hold?.code === "provider-permission-modal") {
        state = await this.authority(async () => {
          const current = await this.options.repository.read();
          return current.hold?.code === "provider-permission-modal" ? this.write(current, { hold: undefined }) : current;
        });
      }
      if (!state.hold && state.desired === "enabled" && !this.disposed && epoch === this.epoch) await this.options.admission.reopen(identity(state)!);
      return;
    }
    if (state.transition?.successor) {
      await this.hold("launch-ownership-unresolved", "A launch identity is assigned. Reconcile owned execution before any retry."); return;
    }
    if (state.hold) return;
    if (state.transition?.nextAttemptAt && Date.parse(state.transition.nextAttemptAt) > Date.now()) {
      this.schedule(Date.parse(state.transition.nextAttemptAt)); return;
    }
    if ((state.transition?.attempts ?? 0) >= RETRY_DELAYS.length) {
      await this.hold("launch-retries-exhausted", "Three passive launch attempts failed; explicit resume starts a new episode."); return;
    }
    if (state.incarnation > 0) { await this.hold("continuity-required", "A previous incarnation requires the succession facility."); return; }
    await this.freeze(state); // Always outside the canonical authority transaction.
    state = await this.authority(async () => {
      const current = await this.options.repository.read();
      if (this.disposed || epoch !== this.epoch || current.desired !== "enabled" || current.activeBinding || current.transition?.successor) return current;
      const successor = { sessionId: randomUUID(), incarnation: current.incarnation + 1, generation: 1 };
      return this.write(current, { transition: { id: current.transition?.id ?? randomUUID(), expectedIncarnation: current.incarnation,
        reason: "passive-start", phase: "launching", attempts: (current.transition?.attempts ?? 0) + 1, successor },
        retainedSessionIds: [...current.retainedSessionIds, successor.sessionId] });
    });
    if (this.disposed || epoch !== this.epoch || state.desired !== "enabled" || !state.transition?.successor) return;
    await this.launch(state, epoch);
  }

  private async launch(reserved: StrigoiState, epoch: number): Promise<void> {
    const transition = reserved.transition!, successor = transition.successor!;
    let activationEntered = false;
    try {
      const { request } = await this.options.manager.prepareResident(reserved.selection!);
      request.providerInstructions += `\n\n${strigoiPrompt(reserved)}`;
      const session = await this.options.registry.start(request, undefined, async (record) => {
        activationEntered = true;
        const current = await this.options.repository.read();
        await this.write(current, { transition: { ...current.transition!, successor: { ...successor, generation: record.generation! } } });
      }, undefined, async (apply) => this.authority(async () => {
        if (this.disposed || this.epoch !== epoch) throw failure("STRIGOI_LAUNCH_CANCELLED");
        await this.validateReservation({ sessionId: successor.sessionId, transitionId: transition.id });
        return apply();
      }), { sessionId: successor.sessionId, transitionId: transition.id });
      if (session.id !== successor.sessionId || !session.generation || !this.owned(session.id)
        || session.executionState !== "active" || session.exitCode !== null) throw failure("STRIGOI_LAUNCH_IDENTITY_MISMATCH");
      const actual = { ...successor, generation: session.generation };
      await this.options.admission.freeze(actual);
      const committed = await this.authority(async () => {
        const current = await this.options.repository.read();
        if (this.disposed || epoch !== this.epoch || current.desired !== "enabled" || current.transition?.successor?.sessionId !== session.id) return undefined;
        const binding = { ...orchestratorLaunchBinding(request, { kind: "fleet" }, session, STRIGOI_KEY, "resident"), resident: { name: "strigoi" as const, incarnation: actual.incarnation } };
        const modal = this.options.registry.workerTruth(session.id).modalOpen;
        return this.write(current, { activeBinding: binding, activeGeneration: actual.generation, incarnation: actual.incarnation,
          transition: { ...current.transition, phase: "complete", successor: actual },
          hold: modal ? { code: "provider-permission-modal", detail: "Provider requires operator input; no automatic answer or model turn.", sourceIds: [session.id] } : undefined });
      });
      if (!committed) { await this.stopOwned(await this.options.repository.read()); return; }
      await this.options.manager.observeResident(committed.activeBinding!, session);
      if (!committed.hold && !this.disposed && epoch === this.epoch) await this.options.admission.reopen(actual);
    } catch (error) {
      if (this.disposed) return;
      await this.authority(async () => {
        const current = await this.options.repository.read();
        if (current.desired !== "enabled" || current.transition?.successor?.sessionId !== successor.sessionId) return;
        if (activationEntered || current.activeBinding) {
          await this.write(current, { hold: { code: "launch-ownership-unresolved", detail: "Launch/activation outcome is unresolved; do not start another process.", sourceIds: [successor.sessionId] } }); return;
        }
        const code = launchFailureCode(error), detail = error instanceof Error ? error.message : String(error);
        const due = Date.now() + RETRY_DELAYS[transition.attempts - 1]!;
        await this.write(current, { transition: { ...transition, successor: undefined, phase: "requested", ...(permanent(code) ? {} : { nextAttemptAt: new Date(due).toISOString() }) },
          hold: permanent(code) ? { code, detail, sourceIds: [successor.sessionId] } : undefined });
        if (!permanent(code)) this.schedule(due);
      });
    }
  }

  private authority<T>(apply: () => Promise<T>): Promise<T> {
    if (!this.options.bindings.withAuthority) throw failure("AUTHORITY_UNAVAILABLE");
    return this.options.bindings.withAuthority(apply);
  }
  private write(state: StrigoiState, patch: Partial<StrigoiState>, mutationId: string = randomUUID()): Promise<StrigoiState> {
    return this.options.repository.compareAndSwap(state.revision, mutationId, { ...state, ...patch, revision: state.revision + 1, updatedAt: new Date().toISOString() });
  }
  private async freeze(state: StrigoiState): Promise<void> {
    const active = identity(state);
    if (active) await this.options.admission.freeze(active);
    if (state.transition?.successor) await this.options.admission.freeze(state.transition.successor);
  }
  private owned(id: string): boolean { try { return this.options.registry.ownsProcess(id); } catch { return false; } }
  private async stopOwned(state: StrigoiState): Promise<void> {
    for (const id of new Set([state.activeBinding?.sessionId, state.transition?.successor?.sessionId])) {
      if (id && this.owned(id)) await this.options.registry.stopResidentProcess(id);
    }
  }
  private async hold(code: string, detail: string): Promise<void> {
    await this.authority(async () => {
      const current = await this.options.repository.read();
      if (current.desired === "enabled" && current.hold?.code !== code) await this.write(current, { hold: { code, detail, sourceIds: [] } });
    });
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(due: number): void {
    this.clearTimer();
    if (this.disposed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile().catch((e: unknown) => this.options.onError?.(e)); }, Math.max(0, due - Date.now()));
    this.timer.unref?.();
  }
}
