import { callerDeadline } from "../orchestration/caller-deadline.js";
import { NOTICE_EXEMPT_TOOLS } from "./notification-tools.js";
import type { McpServerContext } from "./server.js";

const noticeRequests = new WeakMap<McpServerContext, Promise<unknown>>();
const shown = new WeakMap<McpServerContext, { cursor: number; at: number }>();

/** Optional enrichment must neither withhold a primary result nor accumulate hung requests. */
export async function pendingNotice(context: McpServerContext, name: unknown): Promise<Record<string, unknown> | undefined> {
  const transport = context.transport;
  if (transport === undefined || typeof name !== "string" || NOTICE_EXEMPT_TOOLS.has(name)
    || noticeRequests.has(context)) return undefined;
  try {
    const params = { actorSessionId: context.identity.actorSessionId };
    const operation = transport.requestWithDeadline === undefined
      ? transport.request("agent.notifications.peek", params)
      : transport.requestWithDeadline("agent.notifications.peek", params, 200);
    noticeRequests.set(context, operation);
    void operation.then(() => noticeRequests.delete(context), () => noticeRequests.delete(context));
    const result = await callerDeadline(operation, 200, "Optional notification notice");
    if (typeof result !== "object" || result === null || !("notice" in result)) return undefined;
    // Debounce only this process's hints. Durable inbox/hook delivery remains replayable after loss.
    if ("cursor" in result && typeof result.cursor === "number") {
      const previous = shown.get(context);
      if (previous?.cursor === result.cursor && Date.now() - previous.at < 600_000) return undefined;
      shown.set(context, { cursor: result.cursor, at: Date.now() });
    }
    return typeof result.notice === "object" && result.notice !== null && !Array.isArray(result.notice)
      ? result.notice as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
