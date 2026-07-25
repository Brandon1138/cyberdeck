import { RESOLVED_LAUNCH_ENV_KEYS, type ResolvedLaunchRecord } from "../domain/session.js";
import type { ProviderLaunchSpec } from "./provider.js";

const MAX_ARGS = 256;
const MAX_STRING_LENGTH = 4_096;
const MAX_ENV_VALUE_LENGTH = 256;

const CYBERDECK_ENV_KEYS: ReadonlySet<string> = new Set(RESOLVED_LAUNCH_ENV_KEYS);

/**
 * Reduce a spec the broker is about to spawn to the sanitized, bounded record it keeps as the
 * source of record for that launch.
 *
 * The whole point of the sanitizer is `env`: adapters build it by spreading `process.env`, so it
 * holds the operator's API keys and tokens. Nothing outside the Cyberdeck-owned allowlist survives
 * — not the value, not even the key name — and what remains is capped so a catalog entry stays
 * bounded no matter how long an argument or instruction payload was.
 */
export function resolvedLaunchRecord(
  spec: ProviderLaunchSpec,
  mode: "launch" | "resume",
  resolvedAt = new Date().toISOString(),
): ResolvedLaunchRecord {
  let truncated = false;
  const bound = (value: string): string => {
    if (value.length <= MAX_STRING_LENGTH) return value;
    truncated = true;
    return value.slice(0, MAX_STRING_LENGTH);
  };

  const retained = spec.args.slice(0, MAX_ARGS);
  if (retained.length < spec.args.length) truncated = true;

  const cyberdeckEnv: Record<string, string> = {};
  let inheritedEnvCount = 0;
  for (const [key, value] of Object.entries(spec.env)) {
    if (value === undefined) continue;
    if (CYBERDECK_ENV_KEYS.has(key)) {
      cyberdeckEnv[key] = value.slice(0, MAX_ENV_VALUE_LENGTH);
      continue;
    }
    inheritedEnvCount += 1;
  }

  return {
    mode,
    resolvedAt,
    executable: bound(spec.executable),
    args: retained.map(bound),
    cwd: bound(spec.cwd),
    cyberdeckEnv,
    inheritedEnvCount,
    truncated,
  };
}
