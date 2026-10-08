import { settledDedupeKey } from "../domain/orchestrator-notification.js";
import type { NotificationInboxPort } from "./orchestrator-notification-ports.js";
import type { WorkerResultSnapshot } from "./session/session-ports.js";

/**
 * A wait that delivers a target consumes that target's settled record, so the feed does not announce
 * work the orchestrator already saw through the wait. Only the ordinal the caller asked for is
 * consumed; turns completed since are work the feed still owes. A terminal result also consumes the
 * session's terminal record. Acknowledgement failures are swallowed: the wait result is the truth the
 * caller acts on, and a refused acknowledgement only means one extra notice later.
 */
export async function consumeSettledNotifications(
  notifications: Pick<NotificationInboxPort, "acknowledgeByDedupeKey">,
  controllerId: string,
  targets: readonly { sessionId: string; completionTarget: number }[],
  results: readonly WorkerResultSnapshot[],
): Promise<void> {
  const requested = new Map(targets.map((target) => [target.sessionId, target.completionTarget]));
  for (const result of results) {
    const target = requested.get(result.sessionId);
    const keys = [
      ...(result.status === "completed" && target !== undefined ? [settledDedupeKey(result.sessionId, target)] : []),
      ...(result.truth.terminal ? [settledDedupeKey(result.sessionId)] : []),
    ];
    for (const key of keys) {
      await notifications.acknowledgeByDedupeKey(controllerId, key, "wait").catch(() => undefined);
    }
  }
}
