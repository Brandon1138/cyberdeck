import { composerCursor } from "./key-decoder.js";
import { withFleetPreparation } from "./frame-cache.js";
import { normalizeState } from "./normalize.js";
import { normalizeThreadListViewport, renderResolvedFleet } from "./render-frame.js";
import { fleetFrameLayout } from "./runtime-frame.js";
import type { ResolvedFleetRenderOptions } from "./runtime-options.js";
import type { FleetSnapshot, FleetState } from "./state.js";

/** One canonical state/layout pass for viewport, rendered rows, damage topology and caret. */
export function prepareFleetFrame(snapshot: FleetSnapshot, current: FleetState, options: ResolvedFleetRenderOptions) {
  return withFleetPreparation(() => {
    const state = normalizeThreadListViewport(snapshot, normalizeState(current, snapshot, options.now), options);
    const body = renderResolvedFleet(snapshot, state, options);
    return { state, body, cursor: composerCursor(body, state, options.width), layout: fleetFrameLayout(snapshot, state, options) };
  });
}
