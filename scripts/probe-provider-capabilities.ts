/**
 * Read-only capability probes for the installed provider CLIs.
 *
 * Every probe here is metadata only: it prints a version, prints help, reports
 * authentication status, or lists something the installed CLI documents as a
 * listing. No probe may start a session, carry a prompt, select a model, change
 * authentication, install, or update. `assertReadOnlyProbe` enforces that
 * independently of `PROVIDER_PROBES`, so a mistaken allowlist entry still fails
 * before any process is spawned.
 *
 * This module deliberately reports three separate kinds of evidence and never
 * promotes one into another:
 *   - "observed-now"        what a read-only command actually printed here;
 *   - "help-advertised"     a flag the CLI's own help text mentions;
 *   - "unverified-runtime"  behaviour that would require a live session.
 */
import { spawn } from "node:child_process";
import { platform, release, arch } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderProbeId = "claude" | "cursor-agent" | "antigravity";

export type ProbeKind = "version" | "help" | "auth-status" | "listing";

export type EvidenceKind = "observed-now" | "help-advertised" | "unverified-runtime";

export interface CapabilityProbeSpec {
  /** Stable identifier used by tests and documentation. */
  readonly id: string;
  readonly provider: ProviderProbeId;
  readonly executable: string;
  readonly args: readonly string[];
  readonly kind: ProbeKind;
  /** Where the installed CLI documents this command, captured verbatim. */
  readonly documentedBy: string;
}

export interface CapabilityProbeResult {
  readonly id: string;
  readonly provider: ProviderProbeId;
  readonly kind: ProbeKind;
  readonly evidenceKind: "observed-now";
  /** Exact provenance: what was spawned, with which argv. */
  readonly command: { readonly executable: string; readonly args: readonly string[] };
  readonly resolvedPath: string;
  readonly status: "ok" | "failed" | "missing";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AdvertisedFlag {
  readonly flag: string;
  readonly advertised: boolean;
  /** Always false. Help text is never evidence of live behaviour. */
  readonly verifiedLive: false;
}

export interface ObservedSideEffect {
  readonly provider: ProviderProbeId;
  readonly effect: string;
  readonly evidence: string;
  readonly mitigation: string;
}

export interface UnverifiedCapability {
  readonly provider: ProviderProbeId;
  readonly capability: string;
  readonly reason: string;
  readonly evidenceKind: "unverified-runtime";
}

export class ForbiddenProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenProbeError";
  }
}

/**
 * The only argv tokens a probe may contain. This is an allowlist rather than a
 * blocklist so that an unrecognised token — including any bare prompt operand —
 * is rejected by default.
 */
const READ_ONLY_TOKENS: ReadonlySet<string> = new Set([
  "--version",
  "-v",
  "--help",
  "-h",
  "auth",
  "status",
  "whoami",
  "models",
  "agents",
  "--list-models",
]);

/**
 * Tokens called out by name purely so the failure message says why. Anything not
 * in READ_ONLY_TOKENS is rejected regardless of whether it appears here.
 */
const EXPLICITLY_FORBIDDEN: ReadonlyMap<string, string> = new Map([
  ["-p", "print/prompt mode"],
  ["--print", "print/prompt mode"],
  ["--prompt", "print/prompt mode"],
  ["-i", "interactive prompt mode"],
  ["--prompt-interactive", "interactive prompt mode"],
  ["-c", "session continuation"],
  ["--continue", "session continuation"],
  ["--resume", "session continuation"],
  ["--model", "model selection"],
  ["--bg", "background session start"],
  ["--background", "background session start"],
  ["--remote-control", "session start"],
  ["--dangerously-skip-permissions", "permission bypass"],
  ["--allow-dangerously-skip-permissions", "permission bypass"],
  ["login", "authentication change"],
  ["logout", "authentication change"],
  ["setup-token", "authentication change"],
  ["install", "install command"],
  ["update", "update command"],
  ["upgrade", "update command"],
  ["install-shell-integration", "install command"],
  ["uninstall-shell-integration", "install command"],
  ["worker", "starts a cloud worker"],
  ["create-chat", "creates provider state"],
  ["--new-project", "creates provider state"],
]);

/**
 * Verifies that a probe cannot start a session, carry a prompt, change
 * authentication, install, or update. Throws before anything is spawned.
 */
export function assertReadOnlyProbe(spec: CapabilityProbeSpec): void {
  if (spec.args.length === 0) {
    throw new ForbiddenProbeError(
      `${spec.id}: refusing an empty argv; a bare provider command starts an interactive session`,
    );
  }

  for (const arg of spec.args) {
    const reason = EXPLICITLY_FORBIDDEN.get(arg);
    if (reason !== undefined) {
      throw new ForbiddenProbeError(`${spec.id}: "${arg}" is forbidden (${reason})`);
    }
    if (!READ_ONLY_TOKENS.has(arg)) {
      throw new ForbiddenProbeError(
        `${spec.id}: "${arg}" is not an allowlisted read-only token`,
      );
    }
  }
}

/**
 * Probes confirmed against the installed CLIs' own help output. `documentedBy`
 * quotes where each command is described.
 */
export const PROVIDER_PROBES: readonly CapabilityProbeSpec[] = [
  {
    id: "claude.version",
    provider: "claude",
    executable: "claude",
    args: ["--version"],
    kind: "version",
    documentedBy: "claude --help: '-v, --version  Output the version number'",
  },
  {
    id: "claude.help",
    provider: "claude",
    executable: "claude",
    args: ["--help"],
    kind: "help",
    documentedBy: "claude --help: '-h, --help  Display help for command'",
  },
  {
    id: "claude.auth-status",
    provider: "claude",
    executable: "claude",
    args: ["auth", "status"],
    kind: "auth-status",
    documentedBy: "claude auth --help: 'status [options]  Show authentication status'",
  },
  {
    id: "cursor-agent.version",
    provider: "cursor-agent",
    executable: "agent",
    args: ["--version"],
    kind: "version",
    documentedBy: "agent --help: '-v, --version  Output the version number'",
  },
  {
    id: "cursor-agent.help",
    provider: "cursor-agent",
    executable: "agent",
    args: ["--help"],
    kind: "help",
    documentedBy: "agent --help: '-h, --help  Display help for command'",
  },
  {
    id: "cursor-agent.auth-status",
    provider: "cursor-agent",
    executable: "agent",
    args: ["status"],
    kind: "auth-status",
    documentedBy: "agent --help: 'status|whoami [options]  View authentication status'",
  },
  {
    id: "cursor-agent.models",
    provider: "cursor-agent",
    executable: "agent",
    args: ["models"],
    kind: "listing",
    documentedBy: "agent --help: 'models  List available models for this account'",
  },
  {
    id: "antigravity.version",
    provider: "antigravity",
    executable: "agy",
    args: ["--version"],
    kind: "version",
    // Not listed in `agy --help`; observed to print a version and exit. The
    // value is not stable: see OBSERVED_PROBE_SIDE_EFFECTS.
    documentedBy: "not in `agy --help`; observed on 2026-07-21 to print a version and exit",
  },
  {
    id: "antigravity.help",
    provider: "antigravity",
    executable: "agy",
    args: ["--help"],
    kind: "help",
    documentedBy: "agy --help: 'Usage of agy:' banner",
  },
  {
    id: "antigravity.models",
    provider: "antigravity",
    executable: "agy",
    args: ["models"],
    kind: "listing",
    documentedBy: "agy --help: 'models  List available models'",
  },
  {
    id: "antigravity.agents",
    provider: "antigravity",
    executable: "agy",
    args: ["agents"],
    kind: "listing",
    documentedBy: "agy --help: 'agents  List available agents'",
  },
];

/**
 * Side effects observed while running probes that are themselves metadata-only.
 * Cyberdeck does not cause these, cannot suppress them, and must not claim its
 * probes leave the machine untouched while they are present.
 */
export const OBSERVED_PROBE_SIDE_EFFECTS: readonly ObservedSideEffect[] = [
  {
    provider: "antigravity",
    effect:
      "the agy binary replaced itself on disk while only metadata commands were run (no update command was issued)",
    evidence:
      "on 2026-07-21 `agy --version` reported 1.1.4 at 07:45 and 1.1.5 at 07:53; /Users/brandon/.local/bin/agy mtime moved to 07:47:34 in between, and `agy models` changed from display names to model ids",
    mitigation:
      "treat agy version/listing output as a point-in-time reading only; re-probe before relying on it, and never assert that an agy probe left the installation unchanged",
  },
];

/**
 * Capabilities that cannot be established without starting a session or making a
 * model call. B1 deliberately leaves these unproven.
 */
export const UNVERIFIED_RUNTIME_CAPABILITIES: readonly UnverifiedCapability[] = [
  {
    provider: "claude",
    capability: "stream-json frame schema",
    reason:
      "`--output-format stream-json` is help-advertised but its field schema is undocumented in help and would need a live --print run to observe",
    evidenceKind: "unverified-runtime",
  },
  {
    provider: "claude",
    capability: "model listing",
    reason: "the installed claude CLI documents no read-only model-list command",
    evidenceKind: "unverified-runtime",
  },
  {
    provider: "claude",
    capability: "native default model",
    reason:
      "observing it requires starting a session; the recorded baseline showed the native default displaying Fable, so adapters must always pass an explicit non-Fable model",
    evidenceKind: "unverified-runtime",
  },
  {
    provider: "cursor-agent",
    capability: "headless stream-json frame schema",
    reason:
      "`--print --output-format stream-json` is help-advertised but emitting a frame requires a model call",
    evidenceKind: "unverified-runtime",
  },
  {
    provider: "cursor-agent",
    capability: "plan/ask mode runtime behaviour",
    reason: "`--mode plan|ask` is help-advertised as read-only but starts a session to verify",
    evidenceKind: "unverified-runtime",
  },
  {
    provider: "antigravity",
    capability: "authentication status",
    reason: "`agy --help` documents no auth-status command",
    evidenceKind: "unverified-runtime",
  },
  {
    provider: "antigravity",
    capability: "print-mode output format",
    reason: "`--print` exists but its output shape is undocumented and requires a model call",
    evidenceKind: "unverified-runtime",
  },
];

/**
 * Reports whether help text mentions each flag. Never asserts live behaviour:
 * `verifiedLive` is structurally pinned to false.
 */
export function summarizeAdvertisedFlags(
  helpText: string,
  flags: readonly string[],
): readonly AdvertisedFlag[] {
  return flags.map((flag) => ({
    flag,
    advertised: helpText.includes(flag),
    verifiedLive: false,
  }));
}

function locateExecutable(command: string): Promise<string> {
  if (command.includes("/")) {
    return Promise.resolve(command);
  }

  return new Promise((resolvePath) => {
    const child = spawn("/usr/bin/which", [command], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => resolvePath(command));
    child.on("close", (code) => resolvePath(code === 0 ? output.trim() : command));
  });
}

/**
 * Runs one probe. Rejects with ForbiddenProbeError — before spawning anything —
 * if the probe is not provably read-only. A missing executable resolves to
 * status "missing" rather than throwing.
 */
export async function runCapabilityProbe(
  spec: CapabilityProbeSpec,
): Promise<CapabilityProbeResult> {
  assertReadOnlyProbe(spec);

  const resolvedPath = await locateExecutable(spec.executable);
  const base = {
    id: spec.id,
    provider: spec.provider,
    kind: spec.kind,
    evidenceKind: "observed-now",
    command: { executable: spec.executable, args: [...spec.args] },
    resolvedPath,
  } as const;

  return new Promise((resolveResult) => {
    const child = spawn(resolvedPath, [...spec.args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CapabilityProbeResult) => {
      if (!settled) {
        settled = true;
        resolveResult(result);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () =>
      finish({ ...base, status: "missing", exitCode: null, stdout: "", stderr: "" }),
    );
    child.on("close", (code) => {
      finish({
        ...base,
        status: code === 0 ? "ok" : "failed",
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

export async function runAllCapabilityProbes(): Promise<readonly CapabilityProbeResult[]> {
  return Promise.all(PROVIDER_PROBES.map((spec) => runCapabilityProbe(spec)));
}

const READ_ONLY_FLAG = "--read-only";

async function main(argv: readonly string[]): Promise<number> {
  if (!argv.includes(READ_ONLY_FLAG)) {
    process.stderr.write(
      `Refusing to run. This probe executes provider CLIs and only supports its explicitly read-only mode.\nRun: tsx scripts/probe-provider-capabilities.ts ${READ_ONLY_FLAG}\n`,
    );
    return 2;
  }

  const results = await runAllCapabilityProbes();
  process.stdout.write(
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        platform: { platform: platform(), release: release(), arch: arch() },
        note: "Read-only metadata only. No provider session was started and no model call was made. This does not promise the provider CLIs left themselves unchanged; see observedProbeSideEffects.",
        results,
        observedProbeSideEffects: OBSERVED_PROBE_SIDE_EFFECTS,
        unverifiedRuntimeCapabilities: UNVERIFIED_RUNTIME_CAPABILITIES,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
