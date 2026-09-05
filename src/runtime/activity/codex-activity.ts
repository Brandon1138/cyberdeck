import { object, nativeTimestamp, type NativeActivityFrame } from "./provider-activity-collector.js";
/** Codex 0.153.4 rollout response_item frames; screen text is never parsed as tool history. */
export function codexActivity(value: unknown): NativeActivityFrame[] {
  const frame = object(value), payload = object(frame?.payload);
  if (frame?.type !== "response_item" || !payload) return [];
  const type = payload.type;
  const kind = type === "function_call" || type === "custom_tool_call" ? "tool.invocation"
    : type === "function_call_output" || type === "custom_tool_call_output" ? "tool.result"
    : type === "message" && payload.role === "assistant" ? "provider.response" : undefined;
  if (!kind) return [{ kind: "capture.gap", gap: "unknown-frame" }];
  const call = payload.call_id;
  if (kind !== "provider.response" && typeof call !== "string") return [{ kind: "capture.gap", gap: "unknown-frame" }];
  const occurredAt = nativeTimestamp(frame.timestamp);
  return [{ kind, ...(typeof call === "string" ? { toolCallId: call } : {}),
    ...(typeof payload.turn_id === "string" ? { providerTurnId: payload.turn_id } : {}),
    ...(occurredAt === undefined ? {} : { occurredAt }) }];
}
