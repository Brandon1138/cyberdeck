import type { InstructionStateUpdate } from "./session-ports.js";
import { SESSION_UPDATE_FLUSH_MS } from "./session-registry-ports.js";

/**
 * Who is told that something about a session changed.
 *
 * One bus rather than a listener set per collaborator, because every one of these announcements is
 * about the same thing — a session id whose state a reader may now be wrong about — and a reader
 * that had to subscribe in several places would see the same session twice and reconcile it itself.
 */
export class SessionUpdateBus {
  private readonly controllerReleasedListeners = new Set<(sessionId: string) => void>();
  readonly sessionUpdateListeners = new Set<(sessionId: string) => void>();
  private readonly deliveryBoundaryListeners = new Set<(sessionId: string) => void>();
  private readonly instructionStateListeners = new Set<(update: InstructionStateUpdate) => void>();
  /** Sessions whose output has changed but whose update has not been announced yet. */
  private readonly pendingSessionUpdates = new Set<string>();
  private sessionUpdateFlush?: ReturnType<typeof setTimeout>;

  /** Observe material session changes without taking attachment ownership. */
  onSessionUpdate(listener: (sessionId: string) => void): () => void {
    this.sessionUpdateListeners.add(listener);
    return () => this.sessionUpdateListeners.delete(listener);
  }

  onControllerReleased(listener: (sessionId: string) => void): () => void {
    this.controllerReleasedListeners.add(listener);
    return () => this.controllerReleasedListeners.delete(listener);
  }

  /** Announce that a worker which was refusing instructions can take one again. */
  onDeliveryBoundary(listener: (sessionId: string) => void): () => void {
    this.deliveryBoundaryListeners.add(listener);
    return () => this.deliveryBoundaryListeners.delete(listener);
  }

  /** Observe an instruction the broker had already rendered moving on through its lifecycle. */
  onInstructionState(listener: (update: InstructionStateUpdate) => void): () => void {
    this.instructionStateListeners.add(listener);
    return () => this.instructionStateListeners.delete(listener);
  }

  /** Announce that the client holding a session's control lease has let go of it. */
  notifyControllerReleased(sessionId: string): void {
    for (const listener of this.controllerReleasedListeners) listener(sessionId);
  }

  /** Announce that a worker refusing instructions can take one again. */
  notifyDeliveryBoundary(sessionId: string): void {
    for (const listener of this.deliveryBoundaryListeners) listener(sessionId);
  }

  /** Announce that an already-rendered instruction moved on through its lifecycle. */
  notifyInstructionState(update: InstructionStateUpdate): void {
    for (const listener of this.instructionStateListeners) listener(update);
  }

  notifySessionUpdate(sessionId: string): void {
    this.pendingSessionUpdates.delete(sessionId);
    for (const listener of this.sessionUpdateListeners) listener(sessionId);
  }

  /**
   * Announce an output-driven update, at most once per flush interval per session.
   *
   * Every listener of this — waits, the MCP event stream, Fleet's projection — asks the same
   * question about the same state, and a provider streaming a response drives it thousands of times
   * a second. Answering each one inline put all of that work between an operator's keystroke and
   * the broker reading it. Coalescing bounds it to a fixed rate without changing the answer: a
   * pending flush is a session whose latest state is already recorded and merely unannounced.
   *
   * Only the ingest path uses this. Every state transition the broker decides for itself — a turn
   * completing, a fault, an exit, an attention change — still calls {@link notifySessionUpdate}
   * directly, which also flushes anything pending for that session, so nothing material waits on a
   * timer. Bytes are never delayed: the controller and every watcher are written to inline.
   */
  scheduleSessionUpdate(sessionId: string): void {
    this.pendingSessionUpdates.add(sessionId);
    if (this.sessionUpdateFlush !== undefined) return;
    this.sessionUpdateFlush = setTimeout(() => {
      delete this.sessionUpdateFlush;
      this.flushSessionUpdates();
    }, SESSION_UPDATE_FLUSH_MS);
    // A flush must never be the reason a broker stays alive; it has nothing to say about a process
    // that is on its way out.
    this.sessionUpdateFlush.unref?.();
  }

  private flushSessionUpdates(): void {
    const pending = [...this.pendingSessionUpdates];
    this.pendingSessionUpdates.clear();
    for (const sessionId of pending) {
      for (const listener of this.sessionUpdateListeners) listener(sessionId);
    }
  }
}
