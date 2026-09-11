/**
 * What each provider can do under each executor, as facts about this build rather than claims
 * about the present. `supported` is proved by tests or actual runtime evidence named in
 * `evidence`; `unproved` is implemented but waits on a named gate; `unsupported` refuses with the
 * reason a caller sees. No cell here ever falls back to another executor.
 */
export type ExecutionSupportStatus = "supported" | "unproved" | "unsupported";
export interface ExecutionCell {
  status: ExecutionSupportStatus;
  /** What a caller can rely on, or why the launch is refused. */
  reason: string;
  /** The gate that turns unproved into supported, when one exists. */
  gate?: string;
}
export interface ProviderExecutionSupport {
  host: ExecutionCell;
  container: ExecutionCell & {
    transports: readonly ("pty" | "pipe")[];
    authentication: readonly string[];
    resume: string;
    nativeCapture: string;
    /** Launch surfaces that refuse under a required container profile. */
    refused: readonly string[];
  };
}
const CONTAINER_REFUSED = ["scout profile", "image attachments", "worker-provisioned worktrees", "extra writable roots", "job dispatch", "app-server dispatch", "network profile none"] as const;
const AUTH_GATE = "an authorized provider canary (scripts/provider-canary.ts) proving login, one native turn, one native tool, MCP report-back and generation-2 resume";
export const PROVIDER_EXECUTION_SUPPORT: Readonly<Record<"claude" | "codex" | "cursor" | "antigravity", ProviderExecutionSupport>> = {
  claude: {
    host: { status: "supported", reason: "unchanged host launch, resume and permission flags; regression tests" },
    container: { status: "unproved", reason: "subscription canary proves a native turn/tool and attribution; full report-back/resume acceptance remains unproved",
      gate: AUTH_GATE, transports: ["pty", "pipe"], authentication: ["api-key file (ANTHROPIC_API_KEY)", "subscription access token (selected Keychain item or setup-token file)"],
      resume: "explicit native session id persisted from the guest SessionStart hook; unproved against the real CLI",
      nativeCapture: "provider-native turns and tool invocations/results from the private transcript, bound per semantic turn (fixture-proved)",
      refused: CONTAINER_REFUSED },
  },
  codex: {
    host: { status: "supported", reason: "unchanged host launch, resume and permission flags; regression tests" },
    container: { status: "unproved", reason: "ChatGPT read-only and opted-in writable canaries, scoped reporting and generation-2 startup are proved; the full provider acceptance suite remains unproved",
      gate: AUTH_GATE, transports: ["pty", "pipe"], authentication: ["api-key file (OPENAI_API_KEY)", "ChatGPT subscription (access-only auth.json snapshot)"],
      resume: "single rollout under the private sessions root, bound by session_meta id; real generation-2 startup proved, resumed-turn acceptance remains unproved",
      nativeCapture: "provider-native turns and function-call invocations/results from the rollout, bound per semantic turn (fixture-proved)",
      refused: CONTAINER_REFUSED },
  },
  cursor: {
    host: { status: "supported", reason: "unchanged host launch; model column is a launch value, turns come from terminal replay" },
    container: { status: "unsupported", reason: "no Linux guest packaging, no native transcript to bind, and workspace trust is a host-side file; CONTAINER_PROVIDER_UNSUPPORTED",
      transports: [], authentication: [], resume: "unavailable", nativeCapture: "unavailable", refused: CONTAINER_REFUSED },
  },
  antigravity: {
    host: { status: "supported", reason: "unchanged host launch; model column is a launch value, turns come from terminal replay" },
    container: { status: "unsupported", reason: "no Linux guest packaging and no native transcript to bind; CONTAINER_PROVIDER_UNSUPPORTED",
      transports: [], authentication: [], resume: "unavailable", nativeCapture: "unavailable", refused: CONTAINER_REFUSED },
  },
};
export function providerExecutionSupport(provider: string): ProviderExecutionSupport | undefined {
  return Object.hasOwn(PROVIDER_EXECUTION_SUPPORT, provider) ? PROVIDER_EXECUTION_SUPPORT[provider as keyof typeof PROVIDER_EXECUTION_SUPPORT] : undefined;
}
/** Everyday work that still needs the host after the container gates: the operator accepts each one explicitly. */
export const HOST_EXCEPTIONS: readonly { workload: string; reason: string; profile: string }[] = [
  { workload: "Cursor workers", reason: "unsupported container cell", profile: "host-compatible" },
  { workload: "Antigravity workers", reason: "unsupported container cell", profile: "host-compatible" },
  { workload: "Scout (read-only Cursor print transport)", reason: "refused under the container profile", profile: "host-compatible" },
  { workload: "native macOS/iOS builds and simulators", reason: "Linux guest cannot run xcodebuild or devicectl", profile: "host-compatible" },
  { workload: "image-attached prompts", reason: "guest-valid image paths are not staged yet", profile: "host-compatible" },
  { workload: "workers that must create linked worktrees", reason: "the private clone is the worker's whole repository", profile: "host-compatible" },
];
