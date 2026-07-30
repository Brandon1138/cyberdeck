import type { ScoutBrief } from "../domain/worker-profile.js";
import {
  SCOUT_CARD_BEGIN,
  SCOUT_CARD_END,
  SCOUT_EVIDENCE_BEGIN,
  SCOUT_EVIDENCE_END,
} from "../domain/scout-output.js";

/** Legacy framing retained only for recovery of Scouts created before the headless transport. */
export const SCOUT_REPORT_BEGIN = "CYBERDECK_SCOUT_REPORT_BEGIN";
export const SCOUT_REPORT_END = "CYBERDECK_SCOUT_REPORT_END";

/**
 * Provider task text only. Provider, sandbox, approval, MCP isolation, canary, and budgets are
 * resolved and enforced outside this prompt.
 */
export function scoutDispatchPrompt(brief: ScoutBrief): string {
  return [
    "CYBERDECK SCOUT PROFILE — TIER 1",
    "",
    `Objective: ${brief.objective}`,
    ...(brief.hypothesisId === undefined ? [] : [`Hypothesis ID: ${brief.hypothesisId}`]),
    `Scope allowlist: ${brief.scope.join(", ")}`,
    "Questions:",
    ...brief.questions.map((question) => `- ${question}`),
    `Stop condition: ${brief.stopCondition}`,
    `Budget: wall-clock cap ${brief.budget.maxWallClockMs}ms`,
    "",
    "Inspect only listed scope. Do not mutate repository, git state, dependencies, or environment.",
    "Inspect highest-signal scoped symbols first. Stop searching when evidence supports an answer.",
    "Use at most 70% of wall time for search and, when the budget permits, reserve at least 15 seconds for finalization.",
    "Emit a complete valid card early after first decision-relevant evidence. BLOCKED and INCONCLUSIVE are valid outcomes.",
    "Any later replacement must be complete and self-contained.",
    "At the margin, stop tools and emit the best supported valid card.",
    "Do not call createPlan or any planning/reporting tool. The deliverable must be a normal assistant text response, not a tool call.",
    "Keep the complete card within 3,500 characters and use at most 8 evidence bullets. Do not add tables, diagrams, phases, todos, or an implementation plan.",
    "Do not narrate your chronological process. Untaken or rejected branches belong only in evidence when ruling them out changes the parent Orc's decision.",
    "Finish with one compact natural-language decision card using the exact headings and framing below. VERDICT must be SUPPORTED, REFUTED, MIXED, INCONCLUSIVE, BLOCKED, or NEW_FINDING. BASIS must be direct-test, direct-source, history, corroborated, inference, speculation, or none.",
    SCOUT_CARD_BEGIN,
    "QUESTION",
    "<the question or hypothesis answered>",
    "",
    "VERDICT",
    "<one allowed verdict>",
    "",
    "BASIS",
    "<one allowed evidence class>",
    "",
    "FINDING",
    "<the decision-relevant belief update in concise prose>",
    "",
    "EVIDENCE",
    "- <path:symbol or command/test plus the observed fact>",
    "",
    "COVERAGE",
    "<what you inspected and the meaningful boundary of the search>",
    "",
    "CAVEAT",
    "<material uncertainty, or None>",
    "",
    "NEXT PROBE",
    "<highest-information continuation, or None>",
    SCOUT_CARD_END,
    "",
    "If useful, place deeper supporting material after the card. This evidence is durable but is not injected into the Orc's context unless requested.",
    SCOUT_EVIDENCE_BEGIN,
    "<supporting observations, ruled-out theories, commands, and references; concise but not card-limited>",
    SCOUT_EVIDENCE_END,
    "Cyberdeck captures these sections outside the worktree. Do not write a report through shell, file-edit, or MCP tools.",
  ].join("\n");
}
