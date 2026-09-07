import { createHash } from "node:crypto";
import { z } from "zod";
import { plainTerminalLines, plainTerminalText } from "./terminal-replay.js";

/**
 * Structured reading of the blocking provider prompt a worker is parked on.
 *
 * `blocked-modal` used to be the whole answer: the truth engine could say a dialog owned the UI and
 * nothing else, so the only resolution was the operator walking to the pane (the MIK-141 trust
 * dialog incident). This module turns the same recognition into a descriptor an orchestrator can act
 * on lawfully: which dialog it is, a fingerprint of its exact rendered text, and the finite set of
 * answers Cyberdeck knows how to press.
 *
 * Two properties are the whole contract. Answers are enumerated per (provider, kind) — the key
 * bytes live in a static table here, so nothing anywhere can turn an orchestrator string into
 * keystrokes; an unrecognized dialog carries an empty answer set and is unanswerable by
 * construction. And the fingerprint pins an answer to the dialog the caller actually read: the
 * broker re-derives the descriptor at press time and refuses on mismatch, so a stale answer can
 * never land on a different question.
 */

export const ModalKindSchema = z.enum([
  /** Folder / workspace trust dialog raised at 0 turns in an untrusted cwd. */
  "workspace-trust",
  /** Per-action permission approval (run this command, apply these changes). */
  "permission-approval",
  /** Approval gate specifically over an MCP tool call or MCP server load. */
  "mcp-approval",
  /** Claude's plan-mode completion gate ("Would you like to proceed?"). */
  "plan-confirm",
  /** A login / authentication prompt. Never answerable: no keypress answers it safely. */
  "login",
  /** A dialog affordance was detected but no known prompt matched. Unanswerable by construction. */
  "unknown",
]);

export type ModalKind = z.infer<typeof ModalKindSchema>;

export const ModalAnswerOptionSchema = z.object({
  /** Stable identifier an orchestrator names in `worker_ctl answer_modal`. */
  id: z.string().min(1).max(64),
  /** What pressing it does, in the provider's own words where known. */
  label: z.string().min(1).max(160),
});

export type ModalAnswerOption = z.infer<typeof ModalAnswerOptionSchema>;

const EVIDENCE_CHARS = 400;

export const WorkerModalDescriptorSchema = z.object({
  provider: z.string().min(1).max(32),
  kind: ModalKindSchema,
  /** Hash of (provider, kind, normalized dialog text): stable across redraws, new per dialog. */
  fingerprint: z.string().min(8).max(64),
  /** Bounded excerpt of the dialog as rendered, for the orchestrator to verify before answering. */
  evidence: z.string().max(EVIDENCE_CHARS),
  /** The finite set of answers the broker knows how to press. Empty means operator-only. */
  answers: z.array(ModalAnswerOptionSchema).max(8),
});

export type WorkerModalDescriptor = z.infer<typeof WorkerModalDescriptorSchema>;
/** How much rendered text past the match anchor one dialog is allowed to span. */
const EVIDENCE_WINDOW_CHARS = 900;

interface ModalRecognitionRule {
  kind: Exclude<ModalKind, "unknown">;
  /** Must carry the `g` flag: recognition wants the *last* occurrence, not the first. */
  pattern: RegExp;
  answers: readonly ModalAnswerOption[];
}

/**
 * Answer key bytes, deliberately separate from the descriptor an orchestrator sees.
 *
 * The descriptor names answers; only the broker resolves an answer id into bytes, and only through
 * this table. Keys were chosen for determinism over convenience: digit selection where the provider
 * supports it (independent of which row a cursor happens to rest on), the documented single-key
 * affordance where the provider names one (Cursor's `a`), and Escape for every dismissal.
 */
const ANSWER_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "cursor:workspace-trust": { trust: "a", dismiss: "\u001b" },
  "cursor:mcp-approval": { approve: "a", dismiss: "\u001b" },
  "claude:workspace-trust": { trust: "1", exit: "2" },
  "claude:plan-confirm": { "proceed-auto": "1", "proceed-manual": "2", "keep-planning": "3" },
  "claude:permission-approval": { approve: "1", deny: "\u001b" },
  "codex:workspace-trust": { trust: "1", "ask-every-time": "2" },
  "codex:mcp-approval": { approve: "\r", deny: "\u001b" },
  "codex:permission-approval": { approve: "\r", deny: "\u001b" },
  "antigravity:workspace-trust": { trust: "1", dismiss: "\u001b" },
};

const CURSOR_TRUST_ANSWERS: readonly ModalAnswerOption[] = [
  { id: "trust", label: "Trust this workspace and continue" },
  { id: "dismiss", label: "Dismiss without trusting" },
];

const RULES: Readonly<Record<string, readonly ModalRecognitionRule[]>> = {
  cursor: [
    {
      kind: "workspace-trust",
      pattern: /Workspace Trust Required|workspace-trust|Do you trust the (?:files|contents)/giu,
      answers: CURSOR_TRUST_ANSWERS,
    },
    {
      kind: "mcp-approval",
      pattern: /MCP Server Approval Required/giu,
      answers: [
        { id: "approve", label: "Approve the MCP server" },
        { id: "dismiss", label: "Dismiss without approving" },
      ],
    },
  ],
  claude: [
    {
      kind: "workspace-trust",
      pattern: /Do you trust the files in this folder\?/giu,
      answers: [
        { id: "trust", label: "Yes, proceed" },
        { id: "exit", label: "No, exit" },
      ],
    },
    {
      // Plan mode asks "Would you like to proceed?"; the per-action permission prompt asks "Do you
      // want to proceed?". The wording difference is the classifier.
      kind: "plan-confirm",
      pattern: /Would you like to proceed\?/giu,
      answers: [
        { id: "proceed-auto", label: "Yes, and auto-accept edits" },
        { id: "proceed-manual", label: "Yes, and manually approve edits" },
        { id: "keep-planning", label: "No, keep planning" },
      ],
    },
    {
      kind: "permission-approval",
      pattern: /Claude needs your permission|Do you want to proceed\?/giu,
      answers: [
        { id: "approve", label: "Yes, proceed once" },
        { id: "deny", label: "Dismiss the request" },
      ],
    },
  ],
  codex: [
    {
      kind: "workspace-trust",
      pattern:
        /Do you trust the contents of this project\?|allow Codex to work in this (?:folder|directory)/giu,
      answers: [
        { id: "trust", label: "Yes, allow Codex to work in this folder" },
        { id: "ask-every-time", label: "No, ask for approval every time" },
      ],
    },
    {
      kind: "permission-approval",
      pattern:
        /Would you like to (?:run the following command|apply the following changes)\?|Codex needs (?:your )?(?:approval|permission)/giu,
      answers: [
        { id: "approve", label: "Confirm the highlighted default (Yes, proceed)" },
        { id: "deny", label: "Dismiss the request" },
      ],
    },
  ],
  antigravity: [
    {
      kind: "workspace-trust",
      pattern: /Do you trust the (?:files|contents)/giu,
      answers: [
        { id: "trust", label: "Trust this workspace" },
        { id: "dismiss", label: "Dismiss without trusting" },
      ],
    },
  ],
};

/** Prompts no keypress can answer safely, recognized so they are named rather than guessed at. */
const LOGIN_RULE: ModalRecognitionRule = {
  kind: "login",
  pattern:
    /needs authentication|authentication required|please (?:log|sign) in|not (?:logged|signed) in/giu,
  answers: [],
};

/**
 * The kinds an operator grant makes answerable.
 *
 * `permission-approval` is deliberately absent: a per-action approval is the worker's actual
 * security surface, and answering it wholesale is `--dangerously-skip-permissions` with extra
 * steps. It is recognized (so the orchestrator is told exactly what the worker is parked on) and
 * refused by policy, which is where that decision belongs — widening it later is a one-line policy
 * change, not new parsing. `login` and `unknown` are never answerable.
 */
export const ANSWERABLE_MODAL_KINDS: ReadonlySet<ModalKind> = new Set([
  "workspace-trust",
  "mcp-approval",
  "plan-confirm",
]);

/**
 * Read the blocking prompt out of a stripped replay tail.
 *
 * Callers only ask once the truth engine has already decided `blocked-modal`, so this always
 * answers: a tail no rule matches is described as `unknown` with the last rendered lines as
 * evidence, which is precisely the shape that stays unanswerable.
 */
export function describeBlockedModal(provider: string, tail: string): WorkerModalDescriptor {
  const plain = plainTerminalText(tail);
  const rules = [...(RULES[provider] ?? []), LOGIN_RULE];
  let winner: { rule: ModalRecognitionRule; index: number } | undefined;
  for (const rule of rules) {
    const index = lastMatchIndex(plain, rule.pattern);
    // A modal is the last thing drawn, so the rule matching latest in the tail is the one on
    // screen. Strictly-greater keeps rule order as the tiebreak: specific rules are listed first.
    if (index >= 0 && (winner === undefined || index > winner.index)) {
      winner = { rule, index };
    }
  }
  if (winner === undefined) {
    const evidence = normalizeEvidence(plain.slice(-EVIDENCE_WINDOW_CHARS));
    return {
      provider,
      kind: "unknown",
      fingerprint: fingerprintOf(provider, "unknown", evidence),
      evidence,
      answers: [],
    };
  }
  const evidence = normalizeEvidence(
    plain.slice(winner.index, winner.index + EVIDENCE_WINDOW_CHARS),
  );
  const kind = reclassify(winner.rule.kind, evidence);
  const answers = kind === winner.rule.kind
    ? winner.rule.answers
    : answersFor(provider, kind) ?? winner.rule.answers;
  return {
    provider,
    kind,
    fingerprint: fingerprintOf(provider, kind, evidence),
    evidence,
    answers: [...answers],
  };
}

/** The key bytes for one enumerated answer, or undefined for anything outside the table. */
export function modalAnswerKeySequence(
  provider: string,
  kind: ModalKind,
  answerId: string,
): Buffer | undefined {
  const keys = ANSWER_KEYS[`${provider}:${kind}`]?.[answerId];
  return keys === undefined ? undefined : Buffer.from(keys, "utf8");
}

/**
 * Codex names command approval and MCP-tool approval with the same header, so the kind is settled
 * from what the dialog is about rather than from a second regex race.
 */
function reclassify(kind: ModalKind, evidence: string): ModalKind {
  if (kind !== "permission-approval") return kind;
  return /\bMCP\b|\bmcp tool\b|cyberdeck_/iu.test(evidence) ? "mcp-approval" : kind;
}

function answersFor(provider: string, kind: ModalKind): readonly ModalAnswerOption[] | undefined {
  if (kind === "mcp-approval" && provider === "codex") {
    return [
      { id: "approve", label: "Confirm the highlighted default (Yes, proceed)" },
      { id: "deny", label: "Dismiss the request" },
    ];
  }
  return undefined;
}

function lastMatchIndex(value: string, pattern: RegExp): number {
  let index = -1;
  for (const match of value.matchAll(pattern)) index = match.index;
  return index;
}

/**
 * Dialog text reduced to what the provider is asking: deduplicated rendered lines, borders kept
 * (they are part of what the operator would see), bounded so a fingerprint is over the dialog and
 * not over whatever scrolled by beneath it.
 */
function normalizeEvidence(slice: string): string {
  const lines = plainTerminalLines(slice);
  let evidence = lines.join("\n");
  if (evidence.length > EVIDENCE_CHARS) evidence = evidence.slice(0, EVIDENCE_CHARS);
  return evidence;
}

function fingerprintOf(provider: string, kind: ModalKind, evidence: string): string {
  return createHash("sha256")
    .update(provider)
    .update("\u0000")
    .update(kind)
    .update("\u0000")
    .update(evidence)
    .digest("hex")
    .slice(0, 16);
}

/** What one attempted press actually did, in the vocabulary the control plane returns verbatim. */
export type ModalAnswerAttempt =
  | { status: "pressed"; descriptor: WorkerModalDescriptor; answer: ModalAnswerOption }
  | { status: "no-modal" }
  | { status: "unrecognized"; descriptor: WorkerModalDescriptor }
  | { status: "fingerprint-mismatch"; descriptor: WorkerModalDescriptor }
  | { status: "unsupported-answer"; descriptor: WorkerModalDescriptor };
