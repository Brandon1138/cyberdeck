import { z } from "zod";

const CardTextSchema = z.string().trim().min(1).max(16_384);
const OptionalCardTextSchema = z.string().trim().min(1).max(8_192).optional();

export const SCOUT_CARD_BEGIN = "CYBERDECK_SCOUT_CARD_BEGIN";
export const SCOUT_CARD_END = "CYBERDECK_SCOUT_CARD_END";
export const SCOUT_EVIDENCE_BEGIN = "CYBERDECK_SCOUT_EVIDENCE_BEGIN";
export const SCOUT_EVIDENCE_END = "CYBERDECK_SCOUT_EVIDENCE_END";

export const ScoutVerdictSchema = z.enum([
  "SUPPORTED",
  "REFUTED",
  "MIXED",
  "INCONCLUSIVE",
  "BLOCKED",
  "NEW_FINDING",
]);

export const ScoutEvidenceClassSchema = z.enum([
  "direct-test",
  "direct-source",
  "history",
  "corroborated",
  "inference",
  "speculation",
  "none",
]);

export const ScoutDecisionCardSchema = z.object({
  question: CardTextSchema,
  verdict: ScoutVerdictSchema,
  basis: ScoutEvidenceClassSchema,
  finding: CardTextSchema,
  evidence: z.array(CardTextSchema).max(32),
  coverage: CardTextSchema,
  caveat: OptionalCardTextSchema,
  nextProbe: OptionalCardTextSchema,
});

export type ScoutVerdict = z.infer<typeof ScoutVerdictSchema>;
export type ScoutEvidenceClass = z.infer<typeof ScoutEvidenceClassSchema>;
export type ScoutDecisionCard = z.infer<typeof ScoutDecisionCardSchema>;

export type ScoutCardParseResult =
  | {
      state: "complete";
      text: string;
      evidenceText?: string;
      card: ScoutDecisionCard;
    }
  | { state: "partial"; text: string }
  | { state: "invalid"; text: string; reason: string }
  | { state: "missing" };

const HEADINGS = [
  "QUESTION",
  "VERDICT",
  "BASIS",
  "FINDING",
  "EVIDENCE",
  "COVERAGE",
  "CAVEAT",
  "NEXT PROBE",
] as const;

const CursorTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
}).passthrough();

const CursorAssistantEventSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({
    role: z.literal("assistant"),
    content: z.array(z.unknown()),
  }).passthrough(),
}).passthrough();

const CursorSuccessfulResultEventSchema = z.object({
  type: z.literal("result"),
  subtype: z.literal("success"),
  is_error: z.literal(false),
  result: z.string(),
}).passthrough();

/**
 * Parse the compact, human-readable decision card Composer emits. JSON remains a transport detail;
 * the model writes ordinary prose under stable headings so an Orc can read the artifact directly.
 */
export function parseScoutDecisionCard(input: string): ScoutCardParseResult {
  const normalized = input.replace(/\r\n?/gu, "\n");
  const begin = normalized.lastIndexOf(SCOUT_CARD_BEGIN);
  if (begin < 0) return { state: "missing" };
  const contentStart = begin + SCOUT_CARD_BEGIN.length;
  const end = normalized.indexOf(SCOUT_CARD_END, contentStart);
  const text = normalized.slice(contentStart, end < 0 ? undefined : end).trim();
  if (end < 0) return text === "" ? { state: "missing" } : { state: "partial", text };

  const sections = cardSections(text);
  const question = sections.get("QUESTION");
  const verdictText = sections.get("VERDICT")?.split(/\s+/u)[0]?.replace(/[-—:]+$/u, "");
  const basisText = normalizeBasis(sections.get("BASIS"));
  const finding = sections.get("FINDING");
  const evidence = bulletLines(sections.get("EVIDENCE"));
  const coverage = sections.get("COVERAGE");
  if (
    question === undefined
    || verdictText === undefined
    || basisText === undefined
    || finding === undefined
    || coverage === undefined
  ) {
    return {
      state: "invalid",
      text,
      reason: "Scout decision card is missing one or more required headings",
    };
  }

  const parsed = ScoutDecisionCardSchema.safeParse({
    question,
    verdict: verdictText.toUpperCase().replace(/-/gu, "_"),
    basis: basisText,
    finding,
    evidence,
    coverage,
    ...optionalSection("caveat", sections.get("CAVEAT")),
    ...optionalSection("nextProbe", sections.get("NEXT PROBE")),
  });
  if (!parsed.success) {
    return {
      state: "invalid",
      text,
      reason: `Scout decision card does not match the result contract: ${parsed.error.issues[0]?.message ?? "invalid card"}`,
    };
  }

  const evidenceBegin = normalized.lastIndexOf(SCOUT_EVIDENCE_BEGIN);
  const evidenceEnd = evidenceBegin < 0
    ? -1
    : normalized.indexOf(SCOUT_EVIDENCE_END, evidenceBegin + SCOUT_EVIDENCE_BEGIN.length);
  const evidenceText = evidenceBegin < 0 || evidenceEnd < 0
    ? undefined
    : normalized
      .slice(evidenceBegin + SCOUT_EVIDENCE_BEGIN.length, evidenceEnd)
      .trim();
  return {
    state: "complete",
    text: renderScoutDecisionCard(parsed.data),
    ...(evidenceText === undefined || evidenceText === "" ? {} : { evidenceText }),
    card: parsed.data,
  };
}

/** Parse a stored card that no longer carries framing markers. */
export function parseStoredScoutDecisionCard(text: string): ScoutDecisionCard | undefined {
  const parsed = parseScoutDecisionCard(
    `${SCOUT_CARD_BEGIN}\n${text.trim()}\n${SCOUT_CARD_END}`,
  );
  return parsed.state === "complete" ? parsed.card : undefined;
}

export function renderScoutDecisionCard(card: ScoutDecisionCard): string {
  return [
    "QUESTION",
    card.question,
    "",
    "VERDICT",
    card.verdict,
    "",
    "BASIS",
    card.basis,
    "",
    "FINDING",
    card.finding,
    "",
    "EVIDENCE",
    ...(card.evidence.length === 0 ? ["- None"] : card.evidence.map((item) => `- ${item}`)),
    "",
    "COVERAGE",
    card.coverage,
    "",
    "CAVEAT",
    card.caveat ?? "None",
    "",
    "NEXT PROBE",
    card.nextProbe ?? "None",
    "",
  ].join("\n");
}

export function compactScoutDecisionCard(card: ScoutDecisionCard): string {
  return `${card.verdict} · ${card.basis} · ${card.finding}`;
}

/** Extract model-authored text from known Cursor stream-json events only. */
export function scoutFramedTextFromCursorStream(replay: string): string {
  const assistantText: string[] = [];
  let terminalSnapshot: string | undefined;
  for (const line of replay.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.trim() === "") continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }

    const successfulResult = CursorSuccessfulResultEventSchema.safeParse(frame);
    if (successfulResult.success) {
      terminalSnapshot = successfulResult.data.result;
      continue;
    }

    const assistant = CursorAssistantEventSchema.safeParse(frame);
    if (!assistant.success) continue;
    for (const block of assistant.data.message.content) {
      const text = CursorTextBlockSchema.safeParse(block);
      if (text.success) assistantText.push(text.data.text);
    }
  }
  // Successful terminal result repeats Cursor's complete assistant answer. Prefer it instead of
  // appending a duplicate decision card.
  return terminalSnapshot ?? assistantText.join("");
}

function cardSections(text: string): Map<(typeof HEADINGS)[number], string> {
  const result = new Map<(typeof HEADINGS)[number], string>();
  const lines = text.split("\n");
  let active: (typeof HEADINGS)[number] | undefined;
  let buffer: string[] = [];
  const flush = () => {
    if (active !== undefined) {
      const value = buffer.join("\n").trim();
      if (value !== "") result.set(active, value);
    }
    buffer = [];
  };
  for (const line of lines) {
    const candidate = line.trim().toUpperCase();
    const heading = HEADINGS.find((entry) => entry === candidate);
    if (heading !== undefined) {
      flush();
      active = heading;
    } else if (active !== undefined) {
      buffer.push(line);
    }
  }
  flush();
  return result;
}

function bulletLines(value: string | undefined): string[] {
  if (value === undefined || /^none$/iu.test(value.trim())) return [];
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s*/u, "").trim())
    .filter((line) => line !== "" && !/^none$/iu.test(line));
}

function normalizeBasis(value: string | undefined): ScoutEvidenceClass | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
  return ScoutEvidenceClassSchema.safeParse(normalized).success
    ? normalized as ScoutEvidenceClass
    : undefined;
}

function optionalSection<Key extends "caveat" | "nextProbe">(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  if (value === undefined || /^none(?:\s+needed)?[.!]?$/iu.test(value.trim())) return {};
  return { [key]: value.trim() } as Partial<Record<Key, string>>;
}
