import { object, nativeTimestamp, type NativeActivityFrame } from "./provider-activity-collector.js";
/** Claude 2.1.261 native content blocks. Arguments/results remain referenced in local source. */
export function claudeActivity(value: unknown): NativeActivityFrame[] {
  const frame = object(value), message = object(frame?.message);
  if (!frame || !message || !Array.isArray(message.content)) return [];
  const occurredAt = nativeTimestamp(frame.timestamp);
  return message.content.flatMap((raw): NativeActivityFrame[] => {
    const block = object(raw);
    const kind = block?.type === "tool_use" ? "tool.invocation" : block?.type === "tool_result" ? "tool.result"
      : block?.type === "text" && frame.type === "assistant" ? "provider.response" : undefined;
    if (!kind) return []; // Thinking is deliberately not captured or represented.
    const call = block?.type === "tool_use" ? block.id : block?.tool_use_id;
    if (kind !== "provider.response" && typeof call !== "string") return [{ kind: "capture.gap", gap: "unknown-frame" }];
    return [{ kind, ...(typeof call === "string" ? { toolCallId: call } : {}), ...(occurredAt === undefined ? {} : { occurredAt }) }];
  });
}
