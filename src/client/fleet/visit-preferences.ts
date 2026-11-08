import { FleetVisitPreferencesSchema, type FleetReplyWatermark, type FleetVisitPreferences, type FleetLifecycleWatermark } from "../../domain/fleet-preferences.js";
import type { FleetState, FleetTransport } from "./state.js";

export async function loadVisitPreferences(client: FleetTransport): Promise<FleetVisitPreferences | undefined> {
  try {
    return FleetVisitPreferencesSchema.parse(await client.request("fleet.visit", {}));
  } catch { /* Older brokers keep a visit-local baseline; no inferred historical unread. */ }
}

/** Persist only changed watermarks, preserving visit-local state with older brokers. */
export function createVisitPreferenceSaver(
  client: FleetTransport | (() => FleetTransport),
  initial: FleetVisitPreferences | undefined,
  onError: (message: string) => void,
): (state: FleetState) => Promise<void> {
  let savedVisit = initial;
  let failedSave: { client: FleetTransport; payload: string } | undefined;
  return async (state) => {
    if (savedVisit === undefined) return;
    const replies: Record<string, FleetReplyWatermark> = {};
    for (const [id, watermark] of Object.entries(state.replyWatermarks ?? {})) {
      if (JSON.stringify(savedVisit.replies[id]) !== JSON.stringify(watermark)) replies[id] = watermark;
    }
    const lifecycle: Record<string, FleetLifecycleWatermark> = {};
    // An old broker cannot persist lifecycle watermarks; keep notices visit-local there.
    const supportsLifecycle = savedVisit.lifecycle !== undefined;
    if (supportsLifecycle) for (const [id, watermark] of Object.entries(state.lifecycleWatermarks ?? {})) {
      if (JSON.stringify(savedVisit.lifecycle?.[id]) !== JSON.stringify(watermark)) lifecycle[id] = watermark;
    }
    const view = state.listView ?? "live";
    if (Object.keys(replies).length === 0 && savedVisit.view === view && Object.keys(lifecycle).length === 0
      && (!supportsLifecycle || savedVisit.lifecycleInitialized === state.lifecycleInitialized)) return;
    const change = { view, replies, ...(supportsLifecycle ? { lifecycle, lifecycleInitialized: state.lifecycleInitialized } : {}) };
    const transport = typeof client === "function" ? client() : client;
    const payload = JSON.stringify(change);
    if (failedSave?.client === transport && failedSave.payload === payload) return;
    try {
      await transport.request("fleet.visit.set", change);
      failedSave = undefined;
      savedVisit = { ...change, replies: { ...savedVisit.replies, ...replies },
        ...(supportsLifecycle ? { lifecycle: { ...savedVisit.lifecycle, ...lifecycle } } : {}) };
    } catch (error) {
      onError(`Could not save Fleet read/view state: ${error instanceof Error ? error.message : String(error)}`);
      // Retry changed intent or a replacement connection, without retrying an identical failed append each repaint.
      failedSave = { client: transport, payload };
    }
  };
}
