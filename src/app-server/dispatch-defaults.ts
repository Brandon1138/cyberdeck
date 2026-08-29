import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JobRequest } from "../domain/job.js";
import type { ProviderId } from "../domain/provider-registration.js";
import type { WorkerMode } from "../domain/session.js";

const COMPATIBILITY_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
  "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "LC_PAPER",
  "LC_NAME", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT", "LC_IDENTIFICATION", "TZ",
  "COLORTERM", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "CLICOLOR", "CLICOLOR_FORCE",
  "FORCE_COLOR", "NO_COLOR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "SECURITYSESSIONID",
] as const;

const PROXY_AND_TLS_KEYS = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
  "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
] as const;

const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  claude: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL"],
  codex: ["CODEX_HOME", "OPENAI_BASE_URL"],
  cursor: [],
  antigravity: [],
};

export function defaultJobLaunchEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  provider: ProviderId,
  request: Pick<JobRequest, "cwd" | "workerMode">,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  copyExact(environment, source, COMPATIBILITY_KEYS);
  copyExact(environment, source, PROVIDER_KEYS[provider] ?? []);
  copyExact(environment, source, PROXY_AND_TLS_KEYS);
  environment.PWD = request.cwd;
  return {
    ...environment,
    CYBERDECK_PROCESS_ROLE: "worker",
    CYBERDECK_WORKER_MODE: request.workerMode ?? "normal",
  };
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

const MARKER = "CAVEMAN MODE ACTIVE — Cyberdeck worker output policy.";
const FALLBACK_POLICY = [
  "Respond terse like smart caveman. Keep all technical substance.",
  "Drop articles, filler, pleasantries, and hedging. Fragments are fine.",
  "Keep code, commands, API names, technical terms, and error strings exact.",
  "Apply this policy to every response for this worker session.",
].join("\n");

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/u, "");
}

function cavemanWorkerPolicy(env: NodeJS.ProcessEnv): string {
  const path = env.CYBERDECK_CAVEMAN_SKILL
    ?? join(homedir(), ".local", "share", "cyberdeck", "caveman", "SKILL.md");
  try {
    const skill = stripFrontmatter(readFileSync(path, "utf8")).trim();
    if (skill !== "") return `${MARKER}\n\n${skill}`;
  } catch {
    // Caveman is optional. Enabled mode retains deterministic baseline behavior without the skill.
  }
  return `${MARKER}\n\n${FALLBACK_POLICY}`;
}

export function defaultApplyWorkerMode(
  instruction: string,
  mode: WorkerMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (mode !== "caveman" || instruction.includes(MARKER)) return instruction;
  return `${cavemanWorkerPolicy(env)}\n\nWORKER TASK\n${instruction}`;
}
