/** Semantic evidence preserves instruction envelopes that Fleet previews intentionally hide. */
export interface NativeContinuityMessage {
  role: "user" | "assistant" | "developer" | "system";
  text: string;
  occurredAt?: string;
}
export function parseNativeContinuityMessage(provider: string, line: string): NativeContinuityMessage | undefined {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  let frame: Record<string, unknown> | undefined;
  try { frame = object(JSON.parse(line)); } catch { return undefined; }
  if (!frame || frame.isSidechain === true) return undefined;
  const message = object(provider === "claude" ? frame.message : frame.payload);
  if (!message) return undefined;
  let role = message.role, content = message.content;
  if (provider === "claude") {
    if (frame.type !== "user" && frame.type !== "assistant") return undefined;
  } else if (provider === "codex") {
    if (frame.type === "event_msg") {
      role = message.type === "user_message" ? "user" : "assistant";
      content = message.type === "task_complete" ? message.last_agent_message
        : message.type === "agent_message" || message.type === "user_message" ? message.message : undefined;
    } else if (frame.type !== "response_item" || message.type !== "message") return undefined;
  } else return undefined;
  if (role !== "user" && role !== "assistant" && role !== "developer" && role !== "system") return undefined;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => {
    const value = object(block);
    return value && ["text", "input_text", "output_text"].includes(String(value.type)) && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n\n") : "";
  if (!text.trim()) return undefined;
  return { role, text, ...(typeof frame.timestamp === "string" ? { occurredAt: frame.timestamp } : {}) };
}
