import type { JobRequest } from "../domain/job.js";
import type { ProviderId } from "../domain/provider-registration.js";
import type { SessionRecord, WorkerMode } from "../domain/session.js";

export type CyberdeckProcessRole = "worker" | "orchestrator" | "session";
export type ProviderChildTerminal = "pty" | "pipe";

interface LaunchIdentity {
  role: CyberdeckProcessRole;
  workerMode?: WorkerMode;
}

/**
 * Deliberately narrow grant seam. Production launch paths do not currently supply one.
 *
 * A grant value is never read from the source environment, so passing a previously built child
 * environment back as a source does not propagate the grant. A launch or resume needs a fresh,
 * direct grant from a future operator-only boundary.
 */
export interface ProviderChildEnvironmentGrant {
  sshAuthSock: string;
}

export interface ProviderChildEnvironmentOptions {
  source: Readonly<NodeJS.ProcessEnv>;
  provider: ProviderId;
  cwd: string;
  terminal: ProviderChildTerminal;
  identity: LaunchIdentity;
  grant?: Readonly<ProviderChildEnvironmentGrant>;
  disableUpdates?: boolean;
  enableToolSearch?: boolean;
}

const COMPATIBILITY_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
  "TZ",
  "COLORTERM",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "FORCE_COLOR",
  "NO_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  // Retained provisionally until post-restart Claude/macOS Keychain testing proves it unnecessary.
  "SECURITYSESSIONID",
] as const;

const PROXY_AND_TLS_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
] as const;

const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  claude: [
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_BASE_URL",
  ],
  codex: [
    "CODEX_HOME",
    "OPENAI_BASE_URL",
  ],
  cursor: [],
  antigravity: [],
};

/**
 * Build one provider/app-server child environment from reviewed exact-name layers.
 *
 * No source spread, pattern matching, family prefix, or inherit-all path exists. Unknown provider
 * ids receive only the compatibility and proxy/TLS layers. PWD and PTY TERM are launch facts, not
 * inherited shell state.
 */
export function buildProviderChildEnvironment(
  options: ProviderChildEnvironmentOptions,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  copyExact(environment, options.source, COMPATIBILITY_KEYS);
  copyExact(environment, options.source, PROVIDER_KEYS[options.provider] ?? []);
  copyExact(environment, options.source, PROXY_AND_TLS_KEYS);

  environment.PWD = options.cwd;
  if (options.terminal === "pty") environment.TERM = "xterm-256color";

  if (options.grant !== undefined) {
    environment.SSH_AUTH_SOCK = options.grant.sshAuthSock;
  }

  return cyberdeckLaunchEnvironment(environment, options.identity, {
    disableUpdates: options.disableUpdates === true,
    enableToolSearch: options.enableToolSearch === true,
  });
}

/**
 * Apply Cyberdeck-owned constants last. Source, profile, and grant inputs cannot spoof them.
 * Consumers must not treat role/mode metadata as an authorization boundary.
 */
function cyberdeckLaunchEnvironment(
  base: NodeJS.ProcessEnv,
  identity: LaunchIdentity,
  controls: { disableUpdates: boolean; enableToolSearch: boolean },
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...(controls.disableUpdates ? { DISABLE_UPDATES: "1" } : {}),
    ...(controls.enableToolSearch ? { ENABLE_TOOL_SEARCH: "true" } : {}),
    CYBERDECK_PROCESS_ROLE: identity.role,
    CYBERDECK_WORKER_MODE: identity.workerMode ?? "normal",
  };
}

export function sessionLaunchEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  provider: ProviderId,
  cwd: string,
  session: Pick<SessionRecord, "kind" | "workerMode">,
  controls: Pick<
    ProviderChildEnvironmentOptions,
    "disableUpdates" | "enableToolSearch" | "grant"
  > = {},
): NodeJS.ProcessEnv {
  return buildProviderChildEnvironment({
    source,
    provider,
    cwd,
    terminal: "pty",
    identity: {
      role: session.kind ?? "session",
      ...(session.workerMode === undefined ? {} : { workerMode: session.workerMode }),
    },
    ...controls,
  });
}

export function jobLaunchEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  provider: ProviderId,
  request: Pick<JobRequest, "cwd" | "workerMode">,
  controls: Pick<
    ProviderChildEnvironmentOptions,
    "disableUpdates" | "enableToolSearch" | "grant"
  > = {},
): NodeJS.ProcessEnv {
  return buildProviderChildEnvironment({
    source,
    provider,
    cwd: request.cwd,
    terminal: "pipe",
    identity: {
      role: "worker",
      ...(request.workerMode === undefined ? {} : { workerMode: request.workerMode }),
    },
    ...controls,
  });
}

function copyExact(
  target: NodeJS.ProcessEnv,
  source: Readonly<NodeJS.ProcessEnv>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}
