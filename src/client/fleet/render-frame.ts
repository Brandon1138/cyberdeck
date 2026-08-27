import { homedir } from "node:os";
import { scrollFocusedRowIntoView } from "./list-groups.js";
import { fleetListRows, orderedThreads } from "./list-rows.js";
import { normalizeState } from "./normalize.js";
import { renderHandoffPicker } from "./picker-handoff.js";
import { renderOrchestratorPicker } from "./picker-orchestrator.js";
import { renderCommandPalette, renderPermissionPicker } from "./picker-palette.js";
import { renderWorkerPicker } from "./picker-worker.js";
import { renderFleetFooter, renderFleetList, renderHeader } from "./render-list.js";
import { ResolvedFleetRenderOptions } from "./runtime-options.js";
import { FleetRenderOptions, FleetSnapshot, FleetState } from "./state.js";

export function renderFleet(
  snapshot: FleetSnapshot,
  current: FleetState,
  options: FleetRenderOptions = {},
): string {
  // The renderer must use the physical pane width. Fleet can occupy a sub-50-column pane in the
  // automatic three-pane layout; pretending it is 50 columns lets logical rows soft-wrap and
  // invalidates the damage renderer's absolute row addresses.
  const width = Math.max(1, options.width ?? 120);
  const height = Math.max(1, options.height ?? 32);
  const now = options.now ?? Date.now();
  const color = options.color ?? true;
  const home = options.home ?? homedir();
  const pullRequests = options.pullRequests ?? new Map();
  const resolved = { width, height, now, color, home, pullRequests, background: options.background };
  const state = normalizeState(current, snapshot, now);
  if (state.workerPicker !== undefined) {
    return renderWorkerPicker(state, resolved);
  }
  if (state.permissionPicker !== undefined) {
    return renderPermissionPicker(snapshot, state, resolved);
  }
  if (state.commandPalette !== undefined) {
    return renderCommandPalette(state, resolved);
  }
  if (state.handoffPicker !== undefined) {
    return renderHandoffPicker(snapshot, state, resolved);
  }
  if (state.orchestratorPicker !== undefined) {
    return renderOrchestratorPicker(snapshot, state, resolved);
  }
  return renderFleetList(snapshot, state, resolved);
}

export function threadListViewportHeight(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): number {
  const bodyHeight = Math.max(
    0,
    options.height - renderFleetFooter(snapshot, state, options).length,
  );
  return Math.max(
    0,
    bodyHeight - renderHeader(orderedThreads(snapshot), state, options).length - 1,
  );
}

export function normalizeThreadListViewport(
  snapshot: FleetSnapshot,
  state: FleetState,
  options: ResolvedFleetRenderOptions,
): FleetState {
  return scrollFocusedRowIntoView(
    state,
    fleetListRows(snapshot, state),
    threadListViewportHeight(snapshot, state, options),
  );
}

