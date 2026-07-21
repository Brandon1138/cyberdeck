export type AntigravityCapabilitySupport = "supported" | "unsupported" | "live-unverified";

export interface AntigravityCapability {
  readonly capability: string;
  readonly support: AntigravityCapabilitySupport;
  readonly reason: string;
}

/** Evidence register: adapter mechanics are distinct from live provider behavior. */
export const ANTIGRAVITY_CAPABILITIES: readonly AntigravityCapability[] = [
  {
    capability: "interactive-command",
    support: "supported",
    reason: "fixture-proven command construction for a broker-owned PTY; live launch is unverified",
  },
  {
    capability: "headless-one-shot-mechanics",
    support: "supported",
    reason: "fixture-proven bounded process mechanics for the help-advertised --print form",
  },
  {
    capability: "structured-streaming",
    support: "unsupported",
    reason: "agy documents no output-format or structured-streaming surface",
  },
  {
    capability: "workspace-write",
    support: "unsupported",
    reason:
      "accept-edits is documented, but committed evidence does not prove equivalence to workspace-write without automatic approval",
  },
  {
    capability: "agent-selection-from-contract",
    support: "unsupported",
    reason: "the shared request has no explicit agent field and opaque role is never reinterpreted",
  },
  {
    capability: "automatic-model-or-agent-selection",
    support: "unsupported",
    reason: "Cyberdeck neither chooses nor infers a provider-native model or agent",
  },
  {
    capability: "routing-fallback-retry",
    support: "unsupported",
    reason: "the adapter runs only the explicitly selected provider once",
  },
  {
    capability: "durable-headless-conversation",
    support: "unsupported",
    reason: "each bounded job is a fresh invocation and emits no continuation flag",
  },
  {
    capability: "usage-reporting",
    support: "unsupported",
    reason: "no documented usage envelope exists; missing usage remains absent",
  },
  {
    capability: "conversation-resume",
    support: "live-unverified",
    reason: "continuation flags are advertised but their identifiers and durability require a live session",
  },
  {
    capability: "plain-text-result-interpretation",
    support: "live-unverified",
    reason: "agy documents neither a result envelope nor exit-code semantics",
  },
  {
    capability: "headless-prompt-and-output-runtime",
    support: "live-unverified",
    reason: "verifying prompt arity and actual print output requires a forbidden model call",
  },
  {
    capability: "authentication-status",
    support: "live-unverified",
    reason: "agy help documents no authentication-status command",
  },
];

export function antigravityCapability(name: string): AntigravityCapability | undefined {
  return ANTIGRAVITY_CAPABILITIES.find((capability) => capability.capability === name);
}
