import {
  compactScoutDecisionCard,
  parseStoredScoutDecisionCard,
  type ScoutDecisionCard,
} from "../domain/scout-output.js";
import type { WorkerResultSnapshot } from "./session/session-ports.js";

export interface ScoutWaveDigestEntry {
  sessionId: string;
  name?: string;
  hypothesisId?: string;
  result: WorkerResultSnapshot;
  card?: ScoutDecisionCard;
}

export interface ScoutArtifactHandles {
  sessionId: string;
  card: string;
  evidence: string;
  trace: string;
}

export interface ScoutWaveDigest {
  text: string;
  scoutCount: number;
  hypothesisCount: number;
  contradictionCount: number;
  surpriseCount: number;
  handles: ScoutArtifactHandles[];
}

export interface ScoutWaveProjection {
  digest: ScoutWaveDigest;
  results: WorkerResultSnapshot[];
}

/**
 * Deterministic belief reducer for an Orc. It promotes disagreement and novel findings, while raw
 * provider streams and long evidence stay behind explicit artifact handles.
 */
export function projectScoutWave(
  entries: readonly ScoutWaveDigestEntry[],
): ScoutWaveProjection | undefined {
  if (entries.length < 2) return undefined;
  const parsed = entries.map((entry) => ({
    ...entry,
    card: entry.card
      ?? (entry.result.status === "completed"
        ? parseStoredScoutDecisionCard(entry.result.text)
        : undefined),
  }));
  if (!parsed.some(({ card }) => card !== undefined)) return undefined;

  const groups = new Map<string, Array<(typeof parsed)[number]>>();
  for (const entry of parsed) {
    const key = entry.hypothesisId
      ?? entry.card?.question
      ?? entry.name
      ?? entry.sessionId;
    const normalized = key.replace(/\s+/gu, " ").trim().toLowerCase();
    const group = groups.get(normalized) ?? [];
    group.push(entry);
    groups.set(normalized, group);
  }

  const contradictions: string[] = [];
  const surprises: string[] = [];
  const hypothesisLines: string[] = [];
  for (const group of groups.values()) {
    const cards = group.flatMap(({ card, sessionId }) =>
      card === undefined ? [] : [{ card, sessionId }]);
    const verdicts = new Set(cards.map(({ card }) => card.verdict));
    const conflict = verdicts.has("SUPPORTED") && verdicts.has("REFUTED");
    const label = conflict
      ? "CONFLICT"
      : verdicts.size === 1
        ? [...verdicts][0]!
        : verdicts.size > 1
          ? "MIXED"
          : group[0]!.result.status.toUpperCase();
    const title = group[0]!.hypothesisId
      ?? group[0]!.card?.question
      ?? group[0]!.name
      ?? group[0]!.sessionId;
    const findings = cards
      .map(({ card, sessionId }) => `${card.verdict} ${bounded(card.finding, 180)} [${shortId(sessionId)}]`);
    hypothesisLines.push(
      `- ${bounded(title, 140)} · ${label} · ${findings.join(" | ") || group.map(({ result }) => result.status).join(", ")}`,
    );
    if (conflict) contradictions.push(bounded(title, 220));
    for (const { card, sessionId } of cards) {
      if (card.verdict === "NEW_FINDING") {
        surprises.push(`${bounded(card.finding, 220)} [${shortId(sessionId)}]`);
      }
    }
  }

  const handles = entries.map(({ sessionId }) => ({
    sessionId,
    card: `scout://${sessionId}/card`,
    evidence: `scout://${sessionId}/evidence`,
    trace: `scout://${sessionId}/trace`,
  }));
  const rendered = [
    "SCOUT WAVE DIGEST",
    ...hypothesisLines,
    "",
    "CONTRADICTIONS",
    ...(contradictions.length === 0
      ? ["- None observed"]
      : contradictions.map((item) => `- ${item}`)),
    "",
    "SURPRISES",
    ...(surprises.length === 0 ? ["- None"] : surprises.map((item) => `- ${item}`)),
    "",
    "DRILL-DOWN",
    ...handles.map(({ sessionId, card }) =>
      `- ${shortId(sessionId)} ${card} (swap /card for /evidence or /trace)`),
  ].join("\n");
  const text = rendered.length <= MAX_DIGEST_CHARS
    ? rendered
    : `${rendered.slice(0, MAX_DIGEST_CHARS - 72)}…\n[Digest truncated; use structured artifact handles for drill-down]`;

  return {
    digest: {
      text,
      scoutCount: entries.length,
      hypothesisCount: groups.size,
      contradictionCount: contradictions.length,
      surpriseCount: surprises.length,
      handles,
    },
    results: parsed.map(({ result, card }) => ({
      ...result,
      text: compactResult(result, card),
    })),
  };
}

function compactResult(result: WorkerResultSnapshot, card: ScoutDecisionCard | undefined): string {
  if (card !== undefined) return compactScoutDecisionCard(card);
  if (result.status === "failed" || result.status === "budget_exhausted") {
    return bounded(result.text, 320);
  }
  return `${result.status.toUpperCase()} · decision card unavailable; use Scout artifact handle`;
}

function bounded(value: string, maximum: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

const MAX_DIGEST_CHARS = 16_000;
