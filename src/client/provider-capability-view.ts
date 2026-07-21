import {
  ANTIGRAVITY_CAPABILITIES,
  type AntigravityCapabilitySupport,
} from "../providers/antigravity/capabilities.js";

/**
 * How a capability claim below was established. The kinds are deliberately never collapsed into a
 * single "supported" flag, because that is exactly how an advertised flag turns into a promise
 * nobody verified.
 *
 * - `fixture-proven` — Cyberdeck's own mechanics are proven by a deterministic fixture. It proves
 *   what Cyberdeck constructs and how it parses, never what the provider does with it.
 * - `metadata-observed` — a read-only `--version`/`--help`/status command actually printed this on
 *   a recorded date. Version-sensitive; these runtimes self-update.
 * - `help-advertised` — the CLI's own help mentions it. Not proof it works.
 * - `live-unverified` — would require starting a real session or making a model call. Not
 *   established.
 * - `unsupported` — Cyberdeck deliberately does not do this, or the provider documents no surface
 *   for it.
 *
 * There is no `live-proven` row anywhere in this file. Adding one requires an actual authorized
 * paid call, and the test suite asserts its absence so it cannot be granted by editing prose.
 */
export type CapabilityEvidence =
  | "fixture-proven"
  | "metadata-observed"
  | "help-advertised"
  | "live-unverified"
  | "unsupported"
  | "live-proven";

/**
 * One neutral capability statement. The shape carries **no** rank, score, priority, or
 * recommendation field, and the renderer sorts by provider id alphabetically, so no ordering can be
 * read as a preference. Cyberdeck never chooses a provider for the operator.
 */
export interface ProviderCapabilityRow {
  provider: string;
  capability: string;
  evidence: CapabilityEvidence;
  reason: string;
}

/** Canonical provider id → the executable B1 observed on disk. Ids are product ids, not ranks. */
export const PROVIDER_EXECUTABLES = {
  claude: "claude",
  cursor: "agent",
  antigravity: "agy",
} as const;

export type PresentedProvider = keyof typeof PROVIDER_EXECUTABLES;

/** The antigravity register already exists in the adapter; derive rather than re-state it. */
const ANTIGRAVITY_EVIDENCE: Record<AntigravityCapabilitySupport, CapabilityEvidence> = {
  supported: "fixture-proven",
  unsupported: "unsupported",
  "live-unverified": "live-unverified",
};

const ANTIGRAVITY_ROWS: readonly ProviderCapabilityRow[] = ANTIGRAVITY_CAPABILITIES.map(
  (capability) => ({
    provider: "antigravity",
    capability: capability.capability,
    evidence: ANTIGRAVITY_EVIDENCE[capability.support],
    reason: capability.reason,
  }),
);

const CLAUDE_ROWS: readonly ProviderCapabilityRow[] = [
  {
    provider: "claude",
    capability: "interactive-command",
    evidence: "fixture-proven",
    reason: "command construction for a broker-owned PTY is fixture-proven; live launch is unverified",
  },
  {
    provider: "claude",
    capability: "headless-one-shot-mechanics",
    evidence: "fixture-proven",
    reason: "--print with --input-format text and --output-format stream-json is fixture-proven mechanics only",
  },
  {
    provider: "claude",
    capability: "structured-streaming",
    evidence: "fixture-proven",
    reason: "newline-delimited framing is decoded by fixture; the real frame field schema is unobserved",
  },
  {
    provider: "claude",
    capability: "explicit-model-forwarding",
    evidence: "fixture-proven",
    reason: "an explicit --model is forwarded verbatim and an unsafe model fails before argv exists",
  },
  {
    provider: "claude",
    capability: "read-only-permission-mapping",
    evidence: "help-advertised",
    reason: "read-only maps to --permission-mode plan, which help documents but no live run confirms",
  },
  {
    provider: "claude",
    capability: "workspace-write-permission-mapping",
    evidence: "help-advertised",
    reason: "workspace-write maps to --permission-mode manual; bypassPermissions and dontAsk are never emitted",
  },
  {
    provider: "claude",
    capability: "authentication-status",
    evidence: "metadata-observed",
    reason: "claude auth status printed loggedIn on 2026-07-21; this is date- and version-sensitive",
  },
  {
    provider: "claude",
    capability: "omitted-model-safety",
    evidence: "fixture-proven",
    reason:
      "both interactive and headless live-launch boundaries reject omission before process construction; an explicit operator-verified ordinary model is still required",
  },
  {
    provider: "claude",
    capability: "durable-headless-conversation",
    evidence: "unsupported",
    reason: "no resume, continue, fork-session, or session-id flag is emitted; each job is a fresh invocation",
  },
  {
    provider: "claude",
    capability: "automatic-model-or-agent-selection",
    evidence: "unsupported",
    reason: "Cyberdeck neither chooses nor infers a provider-native model",
  },
  {
    provider: "claude",
    capability: "routing-fallback-retry",
    evidence: "unsupported",
    reason: "--fallback-model is never emitted and the adapter runs only the explicitly selected provider",
  },
  {
    provider: "claude",
    capability: "headless-result-runtime",
    evidence: "live-unverified",
    reason: "observing an actual result envelope requires a model call",
  },
];

const CURSOR_ROWS: readonly ProviderCapabilityRow[] = [
  {
    provider: "cursor",
    capability: "interactive-command",
    evidence: "fixture-proven",
    reason: "command construction for a broker-owned PTY is fixture-proven; live launch is unverified",
  },
  {
    provider: "cursor",
    capability: "headless-one-shot-mechanics",
    evidence: "fixture-proven",
    reason: "--print with --output-format stream-json is fixture-proven bounded process mechanics",
  },
  {
    provider: "cursor",
    capability: "structured-streaming",
    evidence: "fixture-proven",
    reason: "newline-delimited framing is decoded by fixture; the real frame field schema is unobserved",
  },
  {
    provider: "cursor",
    capability: "explicit-model-forwarding",
    evidence: "fixture-proven",
    reason: "an explicit --model is forwarded verbatim and never substituted",
  },
  {
    provider: "cursor",
    capability: "read-only-permission-mapping",
    evidence: "help-advertised",
    reason: "read-only maps to --mode plan with --sandbox enabled, which help advertises but no live run confirms",
  },
  {
    provider: "cursor",
    capability: "workspace-write-permission-mapping",
    evidence: "unsupported",
    reason:
      "cursor advertises only plan and ask as read-only modes, so workspace-write omits --mode and no force, yolo, trust, or Smart Auto flag is ever emitted",
  },
  {
    provider: "cursor",
    capability: "authentication-status",
    evidence: "metadata-observed",
    reason: "agent status printed logged in on 2026-07-21; this is date- and version-sensitive",
  },
  {
    provider: "cursor",
    capability: "model-listing",
    evidence: "metadata-observed",
    reason: "agent models printed a listing on 2026-07-21; printing a listing selects nothing",
  },
  {
    provider: "cursor",
    capability: "durable-headless-conversation",
    evidence: "unsupported",
    reason: "--resume is never emitted; each bounded job is a fresh invocation claiming no continuity",
  },
  {
    provider: "cursor",
    capability: "automatic-model-or-agent-selection",
    evidence: "unsupported",
    reason: "Cyberdeck neither chooses nor infers a provider-native model",
  },
  {
    provider: "cursor",
    capability: "routing-fallback-retry",
    evidence: "unsupported",
    reason: "the adapter runs only the explicitly selected provider once",
  },
  {
    provider: "cursor",
    capability: "usage-reporting",
    evidence: "live-unverified",
    reason: "no usage envelope has been observed; missing usage stays unknown and is never zero",
  },
  {
    provider: "cursor",
    capability: "plan-mode-runtime",
    evidence: "live-unverified",
    reason: "confirming that plan mode is genuinely read-only requires starting a session",
  },
];

/** Every presented row, ordered by provider id then capability. Order encodes no preference. */
export const PROVIDER_CAPABILITY_ROWS: readonly ProviderCapabilityRow[] = [
  ...ANTIGRAVITY_ROWS,
  ...CLAUDE_ROWS,
  ...CURSOR_ROWS,
].sort((left, right) =>
  left.provider === right.provider
    ? left.capability.localeCompare(right.capability)
    : left.provider.localeCompare(right.provider),
);

export function capabilityRowsFor(provider: string): ProviderCapabilityRow[] {
  return PROVIDER_CAPABILITY_ROWS.filter((row) => row.provider === provider);
}

export function renderCapabilityMatrix(rows: readonly ProviderCapabilityRow[]): string {
  const lines = [
    "PROVIDER CAPABILITIES",
    "  No capability below was proven by a live model call. Evidence kinds are never merged.",
    ["PROVIDER", "EXECUTABLE", "CAPABILITY", "EVIDENCE", "REASON"].join("\t"),
  ];
  for (const row of rows) {
    const executable = PROVIDER_EXECUTABLES[row.provider as PresentedProvider] ?? "unregistered";
    lines.push([row.provider, executable, row.capability, row.evidence, row.reason].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}
