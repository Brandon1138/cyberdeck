import type { ScoutBrief } from "../domain/worker-profile.js";

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
    `Scope allowlist: ${brief.scope.join(", ")}`,
    "Questions:",
    ...brief.questions.map((question) => `- ${question}`),
    `Stop condition: ${brief.stopCondition}`,
    `Budget: wall-clock cap ${brief.budget.maxWallClockMs}ms; token cap ${brief.budget.maxTokens}`,
    "",
    "Inspect only listed scope. Do not mutate repository, git state, dependencies, or environment.",
    "Return exactly one structured report between markers below. Every finding needs at least one evidence reference with path plus symbol or line range. Coverage must say what was searched and how. Include uncertainties and suggested follow-up probes.",
    SCOUT_REPORT_BEGIN,
    "<JSON matching ScoutReportSchema: findings with evidence; coverage searched/methods; uncertainties; suggestedFollowUpProbes>",
    SCOUT_REPORT_END,
    "Cyberdeck captures framed output into canonical drop-box report. Do not write report through shell, file-edit, or MCP tools.",
  ].join("\n");
}
