import { createHash } from "node:crypto";
import { z } from "zod";
import { plainTerminalLines, plainTerminalText } from "./terminal-replay.js";
import {
  claudeTrustAnswers,
  codexFolderAccessAnswers,
  codexHookReviewAnswers,
} from "./startup-dialog-answers.js";

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
 *
 * Where a dialog has variants, its answers are read off the fingerprinted evidence rather than
 * assumed, so a variant whose rows the key table was not checked against answers nothing.
 */

export const ModalKindSchema = z.enum([
  /** Folder / workspace trust dialog raised at 0 turns in an untrusted cwd. */
  "workspace-trust",
  /**
   * Codex's startup review of hooks that are new or changed since the operator last trusted them.
   * Only continuing without them is ever enumerated: trusting hooks stays with the operator.
   */
  "hook-review",
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

/**
 * One hook as Codex itself identifies it (`hooks/list`). The key says where the hook is declared
 * and the hash says what it runs, so a hook edited in place keeps its key and gets a new identity.
 */
export const ModalHookIdentitySchema = z.object({
  /** Codex's hook key: the declaring source, the event, and the handler's position in it. */
  key: z.string().min(1).max(4_096),
  /** Codex's hash of the normalized handler (`sha256:…`), independent of where it is declared. */
  currentHash: z.string().min(1).max(128),
  /** Codex's verdict against the hashes the operator has trusted. */
  trustStatus: z.enum(["managed", "untrusted", "trusted", "modified"]),
});

export type ModalHookIdentity = z.infer<typeof ModalHookIdentitySchema>;

/** Room for a dialog's options and footer, which the answers are read from. */
const EVIDENCE_CHARS = 1_000;
const MAX_DESCRIBED_HOOKS = 32;

export const WorkerModalDescriptorSchema = z.object({
  provider: z.string().min(1).max(32),
  kind: ModalKindSchema,
  /** Hash of (provider, kind, normalized dialog text): stable across redraws, new per dialog. */
  fingerprint: z.string().min(8).max(64),
  /** Bounded excerpt of the dialog as rendered, for the orchestrator to verify before answering. */
  evidence: z.string().max(EVIDENCE_CHARS),
  /** The finite set of answers the broker knows how to press. Empty means operator-only. */
  answers: z.array(ModalAnswerOptionSchema).max(8),
  /**
   * A hook review's subject when the caller could read Codex's hook inventory: the hooks that are
   * new or changed, ordered by key. Every one of them — listed here or past the bound — is folded
   * into the fingerprint, so an answer read against one set of hooks never lands after it changes.
   */
  hooks: z.array(ModalHookIdentitySchema).max(MAX_DESCRIBED_HOOKS).optional(),
});

export type WorkerModalDescriptor = z.infer<typeof WorkerModalDescriptorSchema>;
/** How much rendered text past the match anchor one dialog is allowed to span. */
const EVIDENCE_WINDOW_CHARS = 900;
/** The span for a rule that names its own last line, which a long path or an error can push out. */
const BOUNDED_EVIDENCE_WINDOW_CHARS = 1_600;

interface ModalRecognitionRule {
  kind: Exclude<ModalKind, "unknown">;
  /** Must carry the `g` flag: recognition wants the *last* occurrence, not the first. */
  pattern: RegExp;
  /** The dialog's last line, without the `g` flag; evidence ends where it first matches. */
  through?: RegExp;
  /** Fixed, or read off the fingerprinted evidence for a dialog whose rows vary. */
  answers: readonly ModalAnswerOption[] | ((evidence: string) => readonly ModalAnswerOption[]);
}

/** Facts the rendered dialog cannot carry, read by the caller from the provider itself. */
export interface ModalDescriptionContext {
  /** Codex's hook inventory for the worker's cwd (`hooks/list`); only a hook review uses it. */
  hooks?: readonly ModalHookIdentity[] | undefined;
}

/**
 * Answer key bytes, deliberately separate from the descriptor an orchestrator sees.
 *
 * The descriptor names answers; only the broker resolves an answer id into bytes, and only through
 * this table. Keys were chosen for determinism over convenience: digit selection where the provider
 * supports it (independent of which row a cursor happens to rest on), the documented single-key
 * affordance where the provider names one (Cursor's `a`), and Escape for dismissals that only
 * dismiss. Where a provider's own source says otherwise, the source wins:
 *
 * - Claude's current trust dialog lists the cancel row first (2.1.261 through 2.1.280 build it with
 *   `cancelFirst`), and its select maps a digit straight to that row, so `2` trusts and `1` takes
 *   whichever cancel the dialog offers. Escape there exits Claude, so it answers nothing.
 * - Codex's `1` only highlights Trust from 0.153.4 on ("a terminal response fragment can start
 *   with `1`") and trusted outright before that. `k` highlights Trust wherever the cursor rests in
 *   every version from 0.40, so `k` then Enter is the one sequence that trusts everywhere. `2`
 *   quits, goes back, or keeps the current directory, depending on why the dialog opened.
 * - Codex's hook review keeps `3`, continue without trusting, immediate (its own test is
 *   `non_trust_startup_hook_shortcuts_remain_immediate`). Reviewing and trusting all have no row.
 */
const ANSWER_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "cursor:workspace-trust": { trust: "a", dismiss: "\u001b" },
  "cursor:mcp-approval": { approve: "a", dismiss: "\u001b" },
  "claude:workspace-trust": { trust: "2", exit: "1", "continue-without-permissions": "1" },
  "claude:plan-confirm": { "proceed-auto": "1", "proceed-manual": "2", "keep-planning": "3" },
  "claude:permission-approval": { approve: "1", deny: "\u001b" },
  "codex:workspace-trust": { trust: "k\r", decline: "2", "ask-every-time": "2" },
  "codex:hook-review": { "continue-without-hooks": "3" },
  "codex:mcp-approval": { approve: "\r", deny: "\u001b" },
  "codex:permission-approval": { approve: "\r", deny: "\u001b" },
  "antigravity:workspace-trust": { trust: "1", dismiss: "\u001b" },
};

/**
 * Hook trust is never granted on the operator's behalf, and folder trust never implies it. An
 * operator grant lets a hook review be answered only by continuing without the hooks it lists —
 * the one press that leaves every new or changed hook switched off. The key table has no row that
 * could trust them; this scope is the policy saying so, so widening the table alone changes nothing.
 */
export const SCOPED_MODAL_ANSWERS: Readonly<Partial<Record<ModalKind, ReadonlySet<string>>>> = {
  "hook-review": new Set(["continue-without-hooks"]),
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
      pattern: /(?:Accessing\s*workspace:?[\s\S]{0,600}?)?Quick\s*safety\s*check:\s*Is\s*this\s*a\s*project/giu,
      through: /Enter\s*to\s*confirm(?:[\s\S]{0,24}?Esc\s*to\s*cancel)?|Press[\s\S]{0,24}?again\s*to\s*exit/iu,
      answers: claudeTrustAnswers,
    },
    {
      // The older dialog lists "1. Yes, proceed" first, the reverse of the current one, and neither
      // build the key table was checked against still draws it. Named, never answered.
      kind: "workspace-trust",
      pattern: /Do\s*you\s*trust\s*the\s*files\s*in\s*this\s*folder\?/giu,
      answers: [],
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
      // 0.158 onward. ratatui positions words with cursor moves, which stripping removes along with
      // the spaces they skipped. Anchored on the footer too, so prose about folder access is not it.
      kind: "workspace-trust",
      pattern: /Folder\s*access(?=[\s\S]{0,1600}?enter\s*continue[\s\S]{0,40}?esc\s*(?:quit|back|cancel))/giu,
      through: /enter\s*continue[\s\S]{0,40}?esc\s*(?:quit|back|cancel)/iu,
      answers: codexFolderAccessAnswers,
    },
    {
      // 0.120 through 0.153.
      kind: "workspace-trust",
      pattern: /(?:You\s*are\s*in[\s\S]{0,600}?)?Do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*directory\?/giu,
      through: /Press\s*enter\s*to\s*continue(?:\s*and\s*create\s*a\s*sandbox\.{3})?/iu,
      answers: [
        { id: "trust", label: "Yes, continue" },
        { id: "decline", label: "No, quit" },
      ],
    },
    {
      // Before 0.120. The question absorbs its own first row, so the evidence starts at the
      // question and keeps the folder it names.
      kind: "workspace-trust",
      pattern:
        /Do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*project\?(?:[\s\S]{0,600}?allow\s*Codex\s*to\s*work\s*in\s*this\s*(?:folder|directory))?|allow\s*Codex\s*to\s*work\s*in\s*this\s*(?:folder|directory)/giu,
      answers: [
        { id: "trust", label: "Yes, allow Codex to work in this folder" },
        { id: "ask-every-time", label: "No, ask for approval every time" },
      ],
    },
    {
      kind: "hook-review",
      pattern: /Hooks\s*need\s*review/giu,
      through: /enter\s*confirm[\s\S]{0,24}?esc\s*skip|Press\s*enter\s*to\s*confirm\s*or\s*esc\s*to\s*go\s*back/iu,
      answers: codexHookReviewAnswers,
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
 * change, not new parsing. `hook-review` is answerable only within {@link SCOPED_MODAL_ANSWERS}.
 * `login` and `unknown` are never answerable.
 */
export const ANSWERABLE_MODAL_KINDS: ReadonlySet<ModalKind> = new Set([
  "workspace-trust",
  "hook-review",
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
export function describeBlockedModal(
  provider: string,
  tail: string,
  context: ModalDescriptionContext = {},
): WorkerModalDescriptor {
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
  const { rule, index } = winner;
  const window = plain.slice(
    index,
    index + (rule.through === undefined ? EVIDENCE_WINDOW_CHARS : BOUNDED_EVIDENCE_WINDOW_CHARS),
  );
  const end = rule.through?.exec(window);
  const evidence = normalizeEvidence(
    end === undefined || end === null ? window : window.slice(0, end.index + end[0].length),
  );
  const kind = reclassify(rule.kind, evidence);
  const answers = kind === rule.kind
    ? answersOf(rule, evidence)
    : answersFor(provider, kind) ?? answersOf(rule, evidence);
  const hooks = kind === "hook-review" ? hooksUnderReview(context.hooks) : undefined;
  return {
    provider,
    kind,
    fingerprint: fingerprintOf(provider, kind, evidence, hooks),
    evidence,
    answers: [...answers],
    ...(hooks === undefined ? {} : { hooks: hooks.slice(0, MAX_DESCRIBED_HOOKS) }),
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

function answersOf(rule: ModalRecognitionRule, evidence: string): readonly ModalAnswerOption[] {
  return typeof rule.answers === "function" ? rule.answers(evidence) : rule.answers;
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

/** What Codex would ask about: hooks it has no trusted hash for, or whose hash has moved. */
function hooksUnderReview(
  hooks: readonly ModalHookIdentity[] | undefined,
): ModalHookIdentity[] | undefined {
  if (hooks === undefined) return undefined;
  return hooks
    .filter((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified")
    .map(({ key, currentHash, trustStatus }) => ({ key, currentHash, trustStatus }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
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

function fingerprintOf(
  provider: string,
  kind: ModalKind,
  evidence: string,
  hooks?: readonly ModalHookIdentity[],
): string {
  const hash = createHash("sha256")
    .update(provider)
    .update("\u0000")
    .update(kind)
    .update("\u0000")
    .update(evidence);
  // Folded in only when present, so a fingerprint with no inventory behind it is unchanged.
  for (const hook of hooks ?? []) {
    hash.update("\n").update(hook.key).update("\u0000").update(hook.currentHash)
      .update("\u0000").update(hook.trustStatus);
  }
  return hash.digest("hex").slice(0, 16);
}

/** What one attempted press actually did, in the vocabulary the control plane returns verbatim. */
export type ModalAnswerAttempt =
  | { status: "pressed"; descriptor: WorkerModalDescriptor; answer: ModalAnswerOption }
  | { status: "no-modal" }
  | { status: "unrecognized"; descriptor: WorkerModalDescriptor }
  | { status: "fingerprint-mismatch"; descriptor: WorkerModalDescriptor }
  | { status: "unsupported-answer"; descriptor: WorkerModalDescriptor };
