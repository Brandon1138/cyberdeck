import { QUIT_CONFIRMATION_MS, QUIT_CONFIRMATION_NOTICE } from "./constants.js";
import type { FleetState, FleetTransition } from "./state.js";

export function transitionQuit(
  state: FleetState,
  key: string,
  now: number,
): FleetTransition | undefined {
  if (key !== "ctrl+c") return undefined;
  if (state.quitConfirmation !== undefined) {
    return {
      state: { ...state, quitConfirmation: undefined, notice: undefined },
      action: { type: "quit" },
    };
  }
  return {
    state: {
      ...state,
      deleteConfirmation: undefined,
      quitConfirmation: { expiresAt: now + QUIT_CONFIRMATION_MS },
      notice: QUIT_CONFIRMATION_NOTICE,
      noticeTone: "confirmation",
    },
  };
}

export function transitionRename(state: FleetState, key: string): FleetTransition {
  if (key === "escape") {
    return { state: { ...state, rename: undefined, notice: undefined } };
  }
  if (key === "enter") {
    const name = state.rename!.draft.trim();
    if (name === "") {
      return {
        state: { ...state, notice: "Thread name cannot be empty", noticeTone: "error" },
      };
    }
    return {
      state: { ...state, rename: undefined, notice: undefined },
      action: { type: "rename", sessionId: state.rename!.sessionId, name },
    };
  }
  if (key === "backspace") {
    return {
      state: {
        ...state,
        rename: {
          ...state.rename!,
          draft: [...state.rename!.draft].slice(0, -1).join(""),
        },
        notice: undefined,
      },
    };
  }
  if ([...key].length === 1 && key.charCodeAt(0) >= 0x20) {
    return {
      state: {
        ...state,
        rename: { ...state.rename!, draft: `${state.rename!.draft}${key}` },
        notice: undefined,
      },
    };
  }
  return { state };
}
