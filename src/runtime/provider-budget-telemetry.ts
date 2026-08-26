export type ProviderBudgetWindow = "weekly" | "session";

export interface ParsedProviderBudgetTelemetry {
  totalTokens?: number;
  tokenObservedAt?: string;
  providerUsage?: {
    window: ProviderBudgetWindow;
    usedPercent: number;
    remainingPercent: number;
    observedAt: string;
  };
}

interface RateLimitCandidate {
  label: string;
  usedPercent: number;
  windowMinutes?: number;
}

/**
 * Parse only provider-authored Codex telemetry frames.
 *
 * Codex has shipped both named primary/secondary windows and window-length-bearing records. The
 * walker accepts either without treating arbitrary prose as usage. Missing fields stay missing.
 */
export function parseCodexBudgetTelemetryLine(
  line: string,
  window: ProviderBudgetWindow,
): ParsedProviderBudgetTelemetry | undefined {
  try {
    const frame = JSON.parse(line) as {
      type?: unknown;
      timestamp?: unknown;
      payload?: { type?: unknown; info?: unknown; rate_limits?: unknown };
    };
    if (frame.type !== "event_msg" || frame.payload?.type !== "token_count") return undefined;
    const info = objectValue(frame.payload.info);
    if (info === undefined) return undefined;
    const observedAt = typeof frame.timestamp === "string"
      ? frame.timestamp
      : new Date().toISOString();
    const usage = objectValue(info.total_token_usage);
    const explicitTotal = finiteNonnegative(usage?.total_tokens);
    const inputTokens = finiteNonnegative(usage?.input_tokens);
    const outputTokens = finiteNonnegative(usage?.output_tokens);
    const totalTokens = explicitTotal
      ?? (inputTokens === undefined && outputTokens === undefined
        ? undefined
        : (inputTokens ?? 0) + (outputTokens ?? 0));

    const candidates: RateLimitCandidate[] = [];
    // Current Codex rollout frames place rate_limits beside info. Older captures and test doubles
    // placed it inside info; accepting both keeps observation compatible without reading prose.
    collectRateLimits(frame.payload.rate_limits, "rate_limits", candidates);
    collectRateLimits(info.rate_limits, "rate_limits", candidates);
    const selected = selectRateLimit(candidates, window);
    if (totalTokens === undefined && selected === undefined) return undefined;
    return {
      ...(totalTokens === undefined ? {} : { totalTokens, tokenObservedAt: observedAt }),
      ...(selected === undefined
        ? {}
        : {
            providerUsage: {
              window,
              usedPercent: selected.usedPercent,
              remainingPercent: Math.max(0, 100 - selected.usedPercent),
              observedAt,
            },
          }),
    };
  } catch {
    return undefined;
  }
}

function collectRateLimits(value: unknown, label: string, output: RateLimitCandidate[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRateLimits(item, `${label}.${index}`, output));
    return;
  }
  const object = objectValue(value);
  if (object === undefined) return;
  const usedPercent = finiteNonnegative(object.used_percent ?? object.usedPercent);
  if (usedPercent !== undefined && usedPercent <= 100) {
    const windowMinutes = finiteNonnegative(object.window_minutes ?? object.windowMinutes);
    output.push({
      label: label.toLowerCase(),
      usedPercent,
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
    });
  }
  for (const [key, child] of Object.entries(object)) {
    if (child === value) continue;
    collectRateLimits(child, `${label}.${key}`, output);
  }
}

function selectRateLimit(
  candidates: readonly RateLimitCandidate[],
  window: ProviderBudgetWindow,
): RateLimitCandidate | undefined {
  const named = candidates.filter((candidate) => window === "weekly"
    ? /(?:secondary|weekly|week)/u.test(candidate.label)
    : /(?:primary|session)/u.test(candidate.label));
  const timed = candidates.filter((candidate) => candidate.windowMinutes !== undefined);
  const pool = named.length > 0 ? named : timed;
  if (pool.length === 0) return candidates.length === 1 ? candidates[0] : undefined;
  return [...pool].sort((left, right) => {
    const leftMinutes = left.windowMinutes ?? (window === "weekly" ? 0 : Number.MAX_SAFE_INTEGER);
    const rightMinutes = right.windowMinutes ?? (window === "weekly" ? 0 : Number.MAX_SAFE_INTEGER);
    return window === "weekly" ? rightMinutes - leftMinutes : leftMinutes - rightMinutes;
  })[0];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
