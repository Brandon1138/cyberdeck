import type { ReasoningEffort, SessionRecord, StartSessionRequest } from "../../domain/session.js";
import { provisionedWorktreeSlug } from "../../domain/worker-workspace.js";
import { fit } from "./render-composer.js";
import { FleetSnapshot, FleetState } from "./state.js";

export function composerWorkspace(instruction: string): StartSessionRequest["workspace"] {
  return {
    branch: `cyberdeck/${provisionedWorktreeSlug(taskName(instruction))}`,
    baseRef: "HEAD",
    provisioning: "cyberdeck-provisioned",
    writableRoots: [],
  };
}

export function taskName(instruction: string): string {
  const singleLine = instruction.replace(/\s+/gu, " ").trim();
  return fit(singleLine, 72);
}

export function composerCwd(state: FleetState, snapshot: FleetSnapshot): string {
  return state.workingDirectory
    ?? snapshot.threads.find(({ record }) => record.id === state.selectedSessionId)?.record.cwd
    ?? state.fallbackCwd;
}

/**
 * Cursor's catalog is one slug per model-and-effort pair, so labels are composed from a family and
 * the slug's effort suffix rather than enumerated. A new rung inside a known family therefore reads
 * correctly in Fleet without a label edit; an unknown family falls back to the raw slug.
 */
export function cursorModelLabel(model: string): string | undefined {
  const families: Record<string, string> = {
    "composer-2.5": "Composer 2.5",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "claude-sonnet-5": "Sonnet 5",
    "claude-opus-5": "Opus 5",
    "claude-opus-5-thinking": "Opus 5 Thinking",
    "claude-fable-5": "Fable 5",
    "claude-fable-5-thinking": "Fable 5 Thinking",
    "cursor-grok-4.5": "Grok 4.5",
    "kimi-k2.7-code": "Kimi K2.7 Code",
    "kimi-k3": "Kimi K3",
    "glm-5.2": "GLM 5.2",
  };
  const efforts: Record<string, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
  };
  const direct = families[model];
  if (direct !== undefined) return direct;
  const separator = model.lastIndexOf("-");
  if (separator === -1) return undefined;
  const family = families[model.slice(0, separator)];
  const effort = efforts[model.slice(separator + 1)];
  return family === undefined || effort === undefined ? undefined : `${family} ${effort}`;
}

/**
 * The model column: what the session is running, not what it was started with.
 *
 * The operator can switch model inside the provider's own CLI, and the launch request cannot know
 * it happened — so this prefers the model the provider itself last recorded. A leading `~` marks a
 * pair that is not fully observed: the provider keeps no transcript to read a running model out of,
 * it has not produced a turn yet, or it named a model without naming an effort. The launch value is
 * still shown, because the alternative is a blank column, but it is shown as the guess it is.
 */
export function threadIdentity(record: SessionRecord): string {
  const observed = record.observedModel;
  const effort = observed?.effort ?? record.effort;
  const unverified = observed === undefined || observed.effort === undefined;
  return `${unverified ? "~" : ""}${friendlyModel(record.provider, observed?.model ?? record.model)
    } · ${friendlyEffort(effort ?? "provider-managed")}`;
}

export function friendlyModel(provider: string, model: string | undefined): string {
  if (model === undefined) return `${titleCase(provider)} Native`;
  if (provider === "cursor") {
    const label = cursorModelLabel(model);
    if (label !== undefined) return label;
  }
  const known: Record<string, string> = {
    "gpt-5.6-luna": "Codex Luna",
    "gpt-5.6-terra": "Codex Terra",
    "gpt-5.6-sol": "Codex Sol",
    haiku: "Claude Haiku",
    sonnet: "Claude Sonnet",
    opus: "Claude Opus",
    fable: "Claude Fable",
    composer: "Cursor Composer",
    "gemini-3.6-flash": "Gemini 3.6 Flash",
    "gemini-3.6-flash-low": "Gemini 3.6 Flash",
    "gemini-3.6-flash-medium": "Gemini 3.6 Flash",
    "gemini-3.6-flash-high": "Gemini 3.6 Flash",
  };
  return known[model] ?? readableSlug(provider, model);
}

/**
 * A model id nothing recognises, made readable without being renamed.
 *
 * An observed id is whatever the provider wrote — `claude-opus-4-8` — and the table above can only
 * ever cover ids that existed when it was written. Words are capitalised as printed and adjacent
 * digit groups are rejoined into the version they were, so `claude-opus-4-8` reads as
 * `Claude Opus 4.8` and is still recognisably the same string. A prefix the provider already
 * supplies is not repeated.
 */
export function readableSlug(provider: string, model: string): string {
  const words: string[] = [];
  for (const token of model.split("-")) {
    const previous = words.at(-1);
    if (/^\d+$/u.test(token) && previous !== undefined && /\d$/u.test(previous)) {
      words[words.length - 1] = `${previous}.${token}`;
      continue;
    }
    words.push(/^[a-z]/u.test(token) ? titleCase(token) : token);
  }
  const readable = words.join(" ");
  return readable.toLowerCase().startsWith(provider.toLowerCase())
    ? readable
    : `${titleCase(provider)} ${readable}`;
}

export function friendlyEffort(effort: ReasoningEffort | "provider-managed"): string {
  return effort === "provider-managed" ? "Provider managed" : effort;
}

export function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

