import { randomUUID } from "node:crypto";
import type { SessionRecord } from "../../domain/session.js";
import { HANDOFF_LIMITS } from "../../domain/worker-handoff.js";
import type { WorkerHandoffResult } from "../../orchestration/worker-handoff-service.js";
import { displayWidth } from "../display-width.js";
import { SELECTION_RULE } from "./constants.js";
import { isTerminalSession, orderedThreads } from "./list-rows.js";
import { existingOrchestratorLabel, existingOrchestrators, pickerRow, renderCursorlessPickerFrame } from "./picker-orchestrator.js";
import { cutToWidthFromEnd, displayThreadName, fit } from "./render-composer.js";
import { renderHeader } from "./render-list.js";
import { boundedIndex } from "./render-rows.js";
import { ResolvedFleetRenderOptions } from "./runtime-options.js";
import { paint, renderNotice } from "./slash-commands.js";
import { FleetSnapshot, FleetState, FleetThread, FleetTransition } from "./state.js";

export const TERMINAL_HANDOFF_REFUSAL = "A terminal worker cannot be handed off";

/** The marked set. Absent and empty mean the same thing everywhere this is read. */
export function handoffMarks(state: FleetState): readonly string[] {
  return state.handoffMarks ?? [];
}

export function isHandoffMarked(state: FleetState, sessionId: string): boolean {
  return handoffMarks(state).includes(sessionId);
}

/**
 * Whether this session is still something a handoff could move.
 *
 * One predicate for every place that claims a worker is handoff-able — the mark filter, the
 * /handoff fallback, and the open picker — so a worker that goes away or exits stops being a
 * target everywhere at once instead of surviving in whichever surface forgot to look again.
 */
export function isHandoffEligible(threads: readonly FleetThread[], sessionId: string): boolean {
  return threads.some(({ record }) =>
    record.id === sessionId && record.kind !== "orchestrator" && !isTerminalSession(record));
}

/**
 * What a handoff would move: the marked workers when there are any, otherwise the selected one.
 *
 * Marks win over the selection so the operator can mark a batch, move focus while reading the rest
 * of the list, and still hand over what they marked rather than wherever the cursor came to rest.
 * An orchestrator is never a target: it is a controller, not something one controls.
 *
 * The fallback is held to exactly what Ctrl+D would accept, and says so when it refuses. A terminal
 * worker that opened the picker anyway would cost the operator both picker steps and the directive
 * they typed, only for the broker to refuse the batch at the end of it.
 */
export function handoffTargets(
  state: FleetState,
  snapshot: FleetSnapshot,
): { workerIds: string[]; refusal?: string; } {
  const marked = handoffMarks(state);
  if (marked.length > 0) return { workerIds: [...marked] };
  const selected = orderedThreads(snapshot).find(({ record }) => record.id === state.selectedSessionId);
  if (selected === undefined || selected.record.kind === "orchestrator") return { workerIds: [] };
  if (isTerminalSession(selected.record)) return { workerIds: [], refusal: TERMINAL_HANDOFF_REFUSAL };
  return { workerIds: [selected.record.id] };
}

/**
 * Orchestrators that could act on a handoff now.
 *
 * A stopped orchestrator would take the leases and never read the directive, so it is not offered
 * — the broker refuses one anyway, and a picker that lists a choice the broker will reject is a
 * worse way to learn that than not listing it.
 */
export function liveOrchestrators(snapshot: FleetSnapshot): SessionRecord[] {
  return existingOrchestrators(snapshot).filter((record) =>
    record.executionState === "active" || record.executionState === "starting");
}

/** Picker hint only. Broker repeats scope validation against durable binding grant. */
export function handoffRecipients(snapshot: FleetSnapshot, workerIds: readonly string[]): SessionRecord[] {
  const records = new Map(snapshot.threads.map(({ record }) => [record.id, record]));
  return liveOrchestrators(snapshot).filter((recipient) =>
    recipient.orchestratorScope === "fleet"
    || workerIds.every((workerId) => records.get(workerId)?.cwd === recipient.cwd));
}

export function openHandoffPicker(state: FleetState, snapshot: FleetSnapshot): FleetTransition {
  const { workerIds, refusal } = handoffTargets(state, snapshot);
  if (workerIds.length === 0) {
    return {
      state: {
        ...state,
        draft: "",
        commandPalette: undefined,
        notice: refusal ?? "Mark workers with ctrl+d, or select one, before /handoff",
        noticeTone: "warning",
      },
    };
  }
  const recipients = handoffRecipients(snapshot, workerIds);
  if (recipients.length === 0) {
    const anyLive = liveOrchestrators(snapshot).length > 0;
    return {
      state: {
        ...state,
        draft: "",
        commandPalette: undefined,
        notice: anyLive
          ? "No live orchestrator covers every worker workspace"
          : "No live orchestrator to receive a handoff",
        noticeTone: "warning",
      },
    };
  }
  return {
    state: {
      ...state,
      draft: "",
      commandPalette: undefined,
      helpOpen: false,
      notice: undefined,
      handoffPicker: { step: "recipient", workerIds, focusSessionId: recipients[0]!.id },
    },
  };
}

/**
 * Hold the open picker's batch to workers that can still be handed off.
 *
 * The operator agreed to a set of workers when they opened this, but a worker exiting is not the
 * operator changing their mind — and the set outlives both picker steps, so without this a worker
 * that dies mid-gesture reaches the broker, which refuses the whole batch and takes the typed
 * directive with it. Newly ineligible members are dropped with the same answer ctrl+d gives, the
 * draft and the recipient survive, and a batch with nothing left in it closes the picker.
 */
export function transitionHandoffPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const open = state.handoffPicker!;
  const threads = orderedThreads(snapshot);
  const workerIds = open.workerIds.filter((id) => isHandoffEligible(threads, id));
  if (workerIds.length === 0) {
    return {
      state: {
        ...state,
        handoffPicker: undefined,
        notice: TERMINAL_HANDOFF_REFUSAL,
        noticeTone: "warning",
      },
    };
  }
  if (workerIds.length === open.workerIds.length) {
    return transitionOpenHandoffPicker(state, snapshot, key);
  }
  const dropped = open.workerIds.length - workerIds.length;
  const narrowed = { ...open, workerIds };
  const transition = transitionOpenHandoffPicker({ ...state, handoffPicker: narrowed }, snapshot, key);
  return {
    ...transition,
    state: {
      ...transition.state,
      // A notice the step itself raised — an empty directive, a closed picker — is the more
      // specific answer and keeps precedence over the bookkeeping one.
      ...(transition.state.notice === undefined
        ? {
          notice: `${TERMINAL_HANDOFF_REFUSAL}; ${dropped} dropped from this handoff`,
          noticeTone: "warning" as const,
        }
        : {}),
    },
  };
}

/**
 * The handoff picker's two steps: who receives, then what they are told.
 *
 * Escape backs out one step rather than the whole gesture, so correcting the recipient does not
 * cost the directive already typed.
 */
export function transitionOpenHandoffPicker(
  state: FleetState,
  snapshot: FleetSnapshot,
  key: string,
): FleetTransition {
  const picker = state.handoffPicker!;
  if (picker.step === "recipient") {
    if (key === "escape") {
      return { state: { ...state, handoffPicker: undefined, notice: undefined } };
    }
    const recipients = handoffRecipients(snapshot, picker.workerIds);
    // The roster can empty while the picker is open — the recipient stopping is exactly the case
    // this gesture must not paper over — so the picker closes rather than offering nothing.
    if (recipients.length === 0) {
      return {
        state: {
          ...state,
          handoffPicker: undefined,
          notice: liveOrchestrators(snapshot).length > 0
            ? "No live orchestrator covers every worker workspace"
            : "No live orchestrator to receive a handoff",
          noticeTone: "warning",
        },
      };
    }
    const focusIndex = Math.max(
      0,
      recipients.findIndex((record) => record.id === picker.focusSessionId),
    );
    if (key === "up" || key === "down") {
      const next = recipients[boundedIndex(focusIndex + (key === "up" ? -1 : 1), recipients.length)]!;
      return { state: { ...state, handoffPicker: { ...picker, focusSessionId: next.id }, notice: undefined } };
    }
    if (key === "enter") {
      return {
        state: {
          ...state,
          handoffPicker: {
            step: "directive",
            workerIds: picker.workerIds,
            recipientSessionId: recipients[focusIndex]!.id,
            draft: "",
            mutationId: randomUUID(),
          },
          notice: undefined,
        },
      };
    }
    return { state };
  }
  if (key === "escape") {
    return {
      state: {
        ...state,
        handoffPicker: {
          step: "recipient",
          workerIds: picker.workerIds,
          focusSessionId: picker.recipientSessionId,
        },
        notice: undefined,
      },
    };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        handoffPicker: { ...picker, draft: [...picker.draft].slice(0, -1).join("") },
        notice: undefined,
      },
    };
  }
  if (key === "enter") {
    const directive = picker.draft.trim();
    // The directive is the whole point of a directed handoff: leases without one are an adoption,
    // which the orchestrator already has its own tool for.
    if (directive === "") {
      return { state: { ...state, notice: "A handoff needs a directive", noticeTone: "error" } };
    }
    if (directive.length > HANDOFF_LIMITS.directiveChars) {
      return {
        state: {
          ...state,
          notice: `A handoff directive can contain at most ${HANDOFF_LIMITS.directiveChars} characters`,
          noticeTone: "error",
        },
      };
    }
    return {
      state: { ...state, handoffPicker: undefined, notice: undefined },
      action: {
        type: "handoff",
        workerIds: picker.workerIds,
        recipientSessionId: picker.recipientSessionId,
        directive,
        mutationId: picker.mutationId,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return {
      state: {
        ...state,
        handoffPicker: { ...picker, draft: `${picker.draft}${key}` },
        notice: undefined,
      },
    };
  }
  return { state };
}

export function renderHandoffDirective(
  draft: string,
  options: ResolvedFleetRenderOptions,
): string {
  const prefix = `${paint("›", "bold", options.color)} `;
  const marker = paint(SELECTION_RULE, "selection", options.color);
  const draftWidth = Math.max(
    0,
    options.width - displayWidth("› ") - displayWidth(SELECTION_RULE),
  );
  const visibleDraft = displayWidth(draft) <= draftWidth
    ? draft
    : `…${cutToWidthFromEnd(draft, Math.max(0, draftWidth - 1))}`;
  return `${prefix}${visibleDraft}${marker}`;
}

export function renderHandoffPicker(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): string {
  const picker = state.handoffPicker!;
  const threads = orderedThreads(snapshot);
  const lines = [
    ...renderHeader(threads, state, options),
    "",
    paint(`Handoff  ${picker.step === "recipient" ? 1 : 2} of 2`, "dim", options.color),
    "",
    `Workers (${picker.workerIds.length})`,
    "",
    // A worker that disappeared between marking and sending is named as gone rather than dropped:
    // the batch is all-or-nothing, so the operator should see the member that will refuse it.
    ...picker.workerIds.map((workerId) => {
      const record = threads.find(({ record: candidate }) => candidate.id === workerId)?.record;
      const short = paint(workerId.slice(0, 8), "dim", options.color);
      return record === undefined
        ? `  ${short}  ${paint("gone", "alert", options.color)}`
        : `  ${displayThreadName(record.name ?? `Untitled ${workerId.slice(0, 8)}`)}  ${short}`;
    }),
    "",
  ];
  if (picker.step === "recipient") {
    const recipients = handoffRecipients(snapshot, picker.workerIds);
    const focusIndex = Math.max(
      0,
      recipients.findIndex((record) => record.id === picker.focusSessionId),
    );
    lines.push("Recipient", "");
    lines.push(...recipients.map((record, index) =>
      pickerRow(existingOrchestratorLabel(record, options.color), index === focusIndex, options.color)));
  } else {
    const recipient = threads.find(({ record }) => record.id === picker.recipientSessionId)?.record;
    lines.push(
      `Directive for ${recipient === undefined
        ? picker.recipientSessionId.slice(0, 8)
        : displayThreadName(recipient.name ?? "orchestrator")
      }`,
      "",
      // Keep the insertion edge and newest text visible after the directive fills the row. Prefix
      // clamping would freeze the retained row, making later direct keystrokes produce no repaint.
      renderHandoffDirective(picker.draft, options),
    );
  }
  const footer = [
    ...(state.notice === undefined
      ? []
      : [renderNotice(state.notice, state.noticeTone, options.width, options.color)]),
    paint("─".repeat(options.width), "dim", options.color),
    paint(
      fit(
        picker.step === "recipient"
          ? "↑↓ select · enter next · esc cancel"
          : "enter hands the workers over · esc back",
        options.width,
      ),
      "dim",
      options.color,
    ),
  ];
  return renderCursorlessPickerFrame(
    lines,
    footer,
    options.height,
    state.notice === undefined ? 0 : 1,
  );
}

/** What the fleet list says about a handoff the broker has already answered. */
export function handoffNotice(result: WorkerHandoffResult): string {
  if (!result.committed) {
    const blocker = result.blocked[0];
    return blocker === undefined ? "Handoff refused" : `Handoff refused · ${blocker.detail}`;
  }
  const count = result.transferred.length;
  const moved = `${count} worker${count === 1 ? "" : "s"} handed off`;
  // A committed transfer whose nudge failed is still a committed transfer, and says so: the
  // orchestrator holds the leases and will read the directive on its next worker_events call.
  return result.delivery === "failed" || result.delivery === "not-attempted"
    ? `${moved} · ${result.deliveryDetail ?? "the orchestrator was not nudged"}`
    : moved;
}

