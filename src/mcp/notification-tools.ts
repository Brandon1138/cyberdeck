/**
 * The orchestrator notification feed's two tools, kept beside the catalog in `server.ts`.
 *
 * Their input schemas mirror the broker's `agent.notifications.read` and
 * `agent.notifications.configure` parameter schemas; the server adds `actorSessionId` itself.
 */
export const NOTIFICATION_TOOLS = [
  {
    name: "cyberdeck_notifications_read",
    description: "Drain the orchestrator notification feed: bounded records about workers this orchestrator controls (settled, intervention, attention, delivery, risk, progress, budget, handoff) written by the broker from the same worker truth cyberdeck_workers_wait and cyberdeck_threads_list project. Call it when a cyberdeckNotice appears beside any tool result or a [cyberdeck notice] line wakes you at the prompt; never poll it on a timer. Delivery is at-least-once: records stay pending until a later call passes acknowledgeThrough with a cursor at or past them, so a lost response replays the same page. A settled record embeds the bounded worker result a wait would return for that single target (retrieval \"notification\"), and a later cyberdeck_workers_wait on the same target answers retrieval \"replay\". Returns {notifications, nextCursor, pending, dropped, policy}; dropped counts records the inbox had to discard under its cap, never silently.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "integer", minimum: 0, default: 0, description: "Read records with a cursor above this one. 0 reads from the oldest pending record." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 50 },
        acknowledgeThrough: { type: "integer", minimum: 0, description: "Acknowledge every pending record at or below this cursor before reading. Pass the previous page's nextCursor." },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["settled", "intervention", "attention", "delivery", "risk", "progress", "budget", "handoff"] },
        },
        severities: { type: "array", items: { type: "string", enum: ["info", "warning", "error", "critical"] } },
        maxResultChars: { type: "integer", minimum: 200, maximum: 4000, default: 1200, description: "Bound on the embedded worker result text of a settled record." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "cyberdeck_notifications_configure",
    description: "Read or change this orchestrator's notification wake policy. wake: \"steering-only\" (default) wakes an idle orchestrator only for settled, intervention, modal attention, delivery, handoff and critical records; \"all\" also wakes on progress; \"off\" never enqueues a wake but notices still ride tool results. quietMinutes repeats an unchanged notice after that long; maxWakesPerHour caps wakes per rolling hour (the cap itself produces one budget record); coalesceMs waits that long for more records before one wake. Pass no policy fields to read the stored policy. Never changes worker lifecycle or leases.",
    inputSchema: {
      type: "object",
      properties: {
        wake: { type: "string", enum: ["all", "steering-only", "off"] },
        quietMinutes: { type: "integer", minimum: 1, maximum: 120 },
        maxWakesPerHour: { type: "integer", minimum: 0, maximum: 120 },
        coalesceMs: { type: "integer", minimum: 0, maximum: 60000 },
      },
      additionalProperties: false,
    },
  },
] as const;

/** Tool calls that must not carry a piggybacked notice: the drain itself, its policy, and diagnosis. */
export const NOTICE_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "cyberdeck_notifications_read",
  "cyberdeck_notifications_configure",
  "cyberdeck_diagnose",
]);
