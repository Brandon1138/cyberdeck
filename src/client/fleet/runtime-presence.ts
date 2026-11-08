import { recordedRuntimePresence, type SessionRuntimePresence } from "../../domain/session-runtime-presence.js";
import type { FleetThread } from "./state.js";

export function threadRuntimePresence(thread: FleetThread): SessionRuntimePresence {
  return thread.runtimePresence ?? recordedRuntimePresence(thread.record);
}

export function isLiveThread(thread: FleetThread): boolean {
  return threadRuntimePresence(thread) === "present";
}

export function isHistoricalThread(thread: FleetThread): boolean {
  return threadRuntimePresence(thread) === "absent";
}
