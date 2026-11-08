import type { SessionRecord } from "./session.js";

/** Process ownership, independent of provider activity, health and task outcome. */
export type SessionRuntimePresence = "present" | "absent" | "unknown";

/** Compatibility for broker lifecycle records; never infer presence from an attention label. */
export function recordedRuntimePresence(record: SessionRecord): SessionRuntimePresence {
  if (typeof record.exitCode === "number") return "absent";
  if (record.exitCode === null && record.pid > 0) return "present";
  return "unknown";
}
