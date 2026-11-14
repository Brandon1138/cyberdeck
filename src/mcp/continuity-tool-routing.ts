import { strigoiToolMethod } from "./strigoi-tools.js";
/** Thin continuity/attention transports share the launch-bound actor, never caller identity. */
export function continuityToolRequest(name: unknown, args: Record<string, unknown>, actorSessionId: string) {
  const resident = strigoiToolMethod(name);
  const method = resident ?? ({
    cyberdeck_notifications_read: "agent.notifications.read",
    cyberdeck_notifications_configure: "agent.notifications.configure",
    cyberdeck_attention_arm: "agent.attention.arm",
    cyberdeck_attention_cancel: "agent.attention.cancel",
  } as Record<string, string>)[String(name)];
  return method ? { method, params: name === "cyberdeck_notifications_configure" ? { actorSessionId, policy: args } : { ...args, actorSessionId } } : undefined;
}
