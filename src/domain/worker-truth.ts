import { z } from "zod";
import type { SessionExecutionState } from "./session.js";

/**
 * The single authoritative per-worker state machine.
 *
 * Before this module every surface answered "what is this worker doing" from its own evidence:
 * `cyberdeck_workers_wait` from the completion ledger, `cyberdeck_threads_list` from the persisted
 * `executionState`/`attentionState` pair, and `cyberdeck_worker_events` from the coordination
 * substrate's lease lifecycle. They disagreed in public — a wait reporting completed turns while the
 * listing reported `active` + `done`, a worker "completed" with zero semantic turns — and an
 * orchestrator had no way to tell which one was lying.
 *
 * `projectWorkerTruth` is the only place a worker's state is decided. Every surface renders the
 * value it returns, so two surfaces can differ in *detail* but never in *verdict*.
 */

/**
 * What the worker is doing, in one word.
 *
 * These are deliberately not the same vocabulary as `SessionExecutionState`. That enum describes an
 * OS process; this one describes an agent. A process that is `active` covers a worker that is
 * thinking, one that is blocked behind a permission modal, and one sitting on an unsent buffer —
 * three situations an orchestrator must act on differently.
 */
export const WorkerTruthStateSchema = z.enum([
  /** Provider process launched, no turn observed yet. */
  "starting",
  /** A provider turn is in flight. */
  "working",
  /** A blocking provider prompt (permission, trust, approval) owns the UI. Nothing will run. */
  "blocked-modal",
  /** Unsent text is sitting in the provider's input surface and no turn is in flight. */
  "blocked-composer",
  /** Alive, input surface clear, nothing in flight. Ready for the next instruction. */
  "idle",
  /** Alive but neither transcript nor token count has moved for the configured stall window. */
  "stalled",
  /** Terminal: the provider refused to continue on its own limits (session cap, prompt length). */
  "provider-limit",
  /** Terminal: an unrecoverable provider fault, possibly with the OS process still alive. */
  "errored",
  /** Terminal: stopped on request. */
  "stopped",
  /** Terminal: exited on its own. */
  "exited",
  /** Terminal: exited non-zero, or a profile-specific failure. */
  "failed",
]);

export type WorkerTruthState = z.infer<typeof WorkerTruthStateSchema>;

const TERMINAL_STATES: ReadonlySet<WorkerTruthState> = new Set([
  "provider-limit",
  "errored",
  "stopped",
  "exited",
  "failed",
]);

export function isTerminalWorkerTruth(state: WorkerTruthState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * A provider that stopped itself on its own limits.
 *
 * These used to reach nobody. A Claude session that hit its five-hour cap, or refused a prompt for
 * being too long, printed the notice into its own transcript and then sat there: `executionState`
 * stayed `active`, the wait kept waiting, and the only way to learn the worker was dead was to
 * attach and read the pane. They are terminal, they are not faults, and the remedy differs per kind,
 * so they carry their own kind rather than collapsing into `errored`.
 */
export const ProviderLimitKindSchema = z.enum(["session-limit", "prompt-too-long"]);

export const ProviderLimitTerminationSchema = z.object({
  kind: ProviderLimitKindSchema,
  /** Operator-facing summary, short enough to sit in a transcript line. */
  reason: z.string(),
  /** The matched provider text, bounded so a terminal dump cannot land in the catalog. */
  detail: z.string(),
});

export type ProviderLimitKind = z.infer<typeof ProviderLimitKindSchema>;
export type ProviderLimitTermination = z.infer<typeof ProviderLimitTerminationSchema>;

/**
 * Why a session stopped, recorded on the durable session record.
 *
 * `executionState` cannot carry this. It answers a question about an OS process, and the whole point
 * of a provider limit is that the process is usually still running. Keeping the reason beside the
 * record rather than inside that enum also means recovery, the fleet view, and every exhaustive
 * switch over execution states keep working unchanged.
 */
export const SessionTerminationSchema = z.object({
  kind: z.enum(["session-limit", "prompt-too-long", "provider-fault"]),
  reason: z.string().max(240),
  detail: z.string().max(240),
  at: z.iso.datetime(),
});

export type SessionTermination = z.infer<typeof SessionTerminationSchema>;

/** What the input surface of the provider TUI is holding. */
export interface ComposerObservation {
  /** A blocking prompt (permission, trust, approval) owns the UI. */
  modalOpen: boolean;
  /** Unsent text is sitting in the composer. Best-effort; see `runtime/composer-state.ts`. */
  occupied: boolean;
  /** The exact rendered line that proved `occupied`, for diagnostics. */
  evidence?: string;
}

export interface WorkerTruthInput {
  executionState: SessionExecutionState;
  exitCode: number | null;
  /** Derived from the PTY replay by `providerTerminalActivity`. */
  activity: "working" | "awaiting-input" | "needs-input" | "unknown";
  composer: ComposerObservation;
  /** Turns the broker has counted, canonical or replay-derived. */
  completedTurns: number;
  /** Subset of `completedTurns` backed by a provider-native transcript turn. */
  canonicalTurns: number;
  /** Instructions accepted by the broker that the provider has not consumed. */
  pendingInstructions: number;
  /** Set once the provider stopped itself on its own limits. */
  providerLimit?: ProviderLimitTermination | undefined;
  stalledForSeconds?: number | undefined;
  /** A Scout's own terminal verdict, which outranks process-shaped guessing. */
  scoutTerminalState?: "complete" | "failed" | "budget_exhausted" | undefined;
  /** True once a stop was requested, so an exit is reported as `stopped` rather than `exited`. */
  stopRequested?: boolean | undefined;
}

export interface WorkerTruth {
  state: WorkerTruthState;
  terminal: boolean;
  completedTurns: number;
  canonicalTurns: number;
  pendingInstructions: number;
  composerOccupied: boolean;
  modalOpen: boolean;
  providerLimit?: ProviderLimitTermination;
  stalledForSeconds?: number;
  /** One sentence an orchestrator can act on without reading anything else. */
  detail: string;
}

/**
 * Decide a worker's state from everything observed about it, in one place.
 *
 * The order below is the whole contract. It reads highest-authority evidence first: a provider that
 * declared its own limit outranks the process outcome that followed it, an errored provider outranks
 * a PTY that is still open, and a blocking modal outranks the "working" spinner that a modal is
 * often drawn on top of.
 */
export function projectWorkerTruth(input: WorkerTruthInput): WorkerTruth {
  const base = {
    completedTurns: input.completedTurns,
    canonicalTurns: input.canonicalTurns,
    pendingInstructions: input.pendingInstructions,
    composerOccupied: input.composer.occupied,
    modalOpen: input.composer.modalOpen,
    ...(input.providerLimit === undefined ? {} : { providerLimit: input.providerLimit }),
  };
  const settle = (state: WorkerTruthState, detail: string): WorkerTruth => ({
    ...base,
    state,
    terminal: isTerminalWorkerTruth(state),
    detail,
  });

  // A provider that named its own limit is the most specific verdict available, and it stays the
  // verdict after the process exits: "hit the session cap" is actionable, "exited 1" is not.
  if (input.providerLimit !== undefined) {
    return settle("provider-limit", input.providerLimit.reason);
  }
  if (input.scoutTerminalState === "budget_exhausted") {
    return settle("stopped", "Scout budget exhausted before a decision card was verified");
  }
  if (input.scoutTerminalState === "failed") {
    return settle("failed", "Scout failed without a verified decision card");
  }
  if (input.executionState === "errored") {
    return settle("errored", "Provider session took an unrecoverable fault");
  }
  if (input.executionState === "cancelled") {
    return settle("stopped", "Stopped on request");
  }
  if (input.executionState === "failed") {
    return settle("failed", `Provider process exited ${input.exitCode ?? "abnormally"}`);
  }
  if (input.executionState === "exited") {
    return settle(
      input.stopRequested === true ? "stopped" : "exited",
      input.stopRequested === true ? "Stopped on request" : "Provider process exited cleanly",
    );
  }
  if (input.executionState === "starting") {
    return settle("starting", "Provider process launching");
  }

  // A modal is drawn over whatever was on screen, so it outranks the activity underneath it. The
  // composer flag is still reported: an instruction that landed in the buffer behind a modal is the
  // exact shape of the MIK-64 incident and must stay visible.
  if (input.composer.modalOpen || input.activity === "needs-input") {
    return settle(
      "blocked-modal",
      input.composer.occupied
        ? "Blocked on a provider prompt with unsent text in the composer"
        : "Blocked on a provider prompt; no turn will run until it is answered",
    );
  }
  if (input.activity === "working") {
    return settle("working", "Provider turn in flight");
  }
  if (input.composer.occupied) {
    return settle(
      "blocked-composer",
      "Unsent text is sitting in the provider composer; no turn is running",
    );
  }
  if (input.stalledForSeconds !== undefined) {
    return {
      ...settle("stalled", `No transcript or token movement for ${input.stalledForSeconds}s`),
      stalledForSeconds: input.stalledForSeconds,
    };
  }
  return settle(
    "idle",
    input.pendingInstructions > 0
      ? `Idle with ${input.pendingInstructions} instruction(s) accepted but not yet submitted`
      : `Idle after ${input.completedTurns} completed turn(s)`,
  );
}

/**
 * The instruction lifecycle, which is a different question from the worker's.
 *
 * `cyberdeck_thread_message` used to answer `delivered` the instant the payload was written at a
 * PTY. Writing bytes at a terminal is not delivery: at a permission modal the full instruction sat
 * in the composer, unsent, while the caller had already been told it landed. These six states name
 * the six things that were being conflated, and each transition is only taken on evidence.
 */
export const InstructionLifecycleStateSchema = z.enum([
  /** (1) The broker validated and durably recorded it. Nothing has reached the provider. */
  "accepted",
  /** (2) Waiting for a safe provider boundary. Deliberately not written yet. */
  "queued",
  /** (3) Written into the provider's input surface. Visible, not consumed. */
  "rendered",
  /** (4) The provider consumed the input surface. */
  "submitted",
  /** (5) A provider turn started for this instruction. */
  "acknowledged",
  /** (6) The canonical provider turn for this instruction completed. */
  "completed",
  /** Terminal: the worker went terminal before the provider ever consumed it. */
  "undelivered",
  /** Terminal: withdrawn before submission. */
  "cancelled",
]);

export type InstructionLifecycleState = z.infer<typeof InstructionLifecycleStateSchema>;

const INSTRUCTION_TRANSITIONS: Readonly<
  Record<InstructionLifecycleState, readonly InstructionLifecycleState[]>
> = {
  accepted: ["queued", "rendered", "undelivered", "cancelled"],
  queued: ["rendered", "undelivered", "cancelled"],
  // Nothing goes back from `rendered`: bytes written at a terminal cannot be unwritten. The only
  // protection against a polluted composer is refusing to write, which is why `queued` exists.
  rendered: ["submitted", "undelivered"],
  submitted: ["acknowledged", "completed", "undelivered"],
  acknowledged: ["completed", "undelivered"],
  completed: [],
  undelivered: [],
  cancelled: [],
};

export function instructionTransitionAllowed(
  from: InstructionLifecycleState,
  to: InstructionLifecycleState,
): boolean {
  return INSTRUCTION_TRANSITIONS[from].includes(to);
}

/**
 * Advance an instruction, refusing any move the table does not allow.
 *
 * Returning the current state for a disallowed move rather than throwing is deliberate: the callers
 * are observation paths driven by PTY output, and a late duplicate observation must not become an
 * exception on the broadcast path.
 */
export function advanceInstruction(
  from: InstructionLifecycleState,
  to: InstructionLifecycleState,
): InstructionLifecycleState {
  return instructionTransitionAllowed(from, to) ? to : from;
}

/** True once the provider has consumed the payload; the only honest basis for a delivery claim. */
export function instructionReachedProvider(state: InstructionLifecycleState): boolean {
  return state === "submitted" || state === "acknowledged" || state === "completed";
}

/** Why an instruction is sitting in `queued` rather than being written. */
export const DeliveryHoldReasonSchema = z.enum([
  /** A human controller owns the thread; human control always has priority. */
  "human-controller",
  /** A blocking provider prompt owns the UI. Writing now would land in the composer, unsent. */
  "provider-modal",
  /** The composer already holds text; appending would corrupt whatever is there. */
  "composer-occupied",
  /** The worker is terminal and will never consume anything. */
  "worker-terminal",
]);

export type DeliveryHoldReason = z.infer<typeof DeliveryHoldReasonSchema>;

export const DELIVERY_HOLD_DETAIL: Readonly<Record<DeliveryHoldReason, string>> = {
  "human-controller": "A human controller currently owns this thread",
  "provider-modal": "The worker is blocked at a provider prompt; the instruction is held until it clears",
  "composer-occupied": "The worker's composer already holds unsent text; the instruction is held until it clears",
  "worker-terminal": "The worker is terminal and cannot consume this instruction",
};
