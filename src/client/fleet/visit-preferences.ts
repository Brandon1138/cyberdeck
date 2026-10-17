import { FleetVisitPreferencesSchema, type FleetReplyWatermark, type FleetVisitPreferences } from "../../domain/fleet-preferences.js";
import type { FleetState, FleetTransport } from "./state.js";

export async function loadVisitPreferences(client: FleetTransport): Promise<FleetVisitPreferences | undefined> {
  try {
    return FleetVisitPreferencesSchema.parse(await client.request("fleet.visit", {}));
  } catch { /* Older brokers keep a visit-local baseline; no inferred historical unread. */ }
}

/** Persist only changed watermarks, preserving visit-local state with older brokers. */
export function createVisitPreferenceSaver(
  client: FleetTransport,
  initial: FleetVisitPreferences | undefined,
  onError: (message: string) => void,
): (state: FleetState) => Promise<void> {
  let savedVisit = initial;
  return async (state) => {
    if (savedVisit === undefined) return;
    const replies: Record<string, FleetReplyWatermark> = {};
    for (const [id, watermark] of Object.entries(state.replyWatermarks ?? {})) {
      if (JSON.stringify(savedVisit.replies[id]) !== JSON.stringify(watermark)) replies[id] = watermark;
    }
    const view = state.listView ?? "live";
    if (Object.keys(replies).length === 0 && savedVisit.view === view) return;
    try {
      await client.request("fleet.visit.set", { view, replies });
      savedVisit = { view, replies: { ...savedVisit.replies, ...replies } };
    } catch (error) {
      onError(`Could not save Fleet read/view state: ${error instanceof Error ? error.message : String(error)}`);
      // Keep in-memory state stable, and avoid writing the same failed append each repaint.
      savedVisit = undefined;
    }
  };
}
