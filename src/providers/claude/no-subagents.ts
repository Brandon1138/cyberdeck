/**
 * Operator policy: Claude must never spawn Claude-native subagents.
 *
 * Keep both layers. The documented CLI denial removes the current Agent/Task tools, while the
 * runtime ceilings fail closed if a launch surface exposes them despite the argv restriction.
 * Cyberdeck must carry this policy itself because orchestrators intentionally exclude user settings.
 */
export const CLAUDE_NO_SUBAGENT_ENV: Readonly<NodeJS.ProcessEnv> = {
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "0",
  CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: "0",
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "0",
  CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1",
  CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
};

/**
 * Denials the operator's user settings carry but an orchestrator never receives. `--setting-sources
 * project,local` drops user scope, so a `permissions.deny` entry in `~/.claude/settings.json` has
 * no effect on an orchestrator and has to be re-asserted on argv. Workers keep user settings and
 * are already covered, which is why this is not applied to them.
 *
 * Denial blocks invocation only. It does not remove a skill from the session's context: measured
 * against 2.1.220, prompt size was identical (8,923 tokens) with and without the flag, and the
 * skill stayed in the advertised list. Reducing what is *loaded* is `--disable-slash-commands`,
 * a different and much wider lever.
 */
export const CLAUDE_ORCHESTRATOR_TOOL_DENIALS: readonly string[] = ["Skill(update-config)"];

/**
 * One `--disallowedTools` flag, always. A second occurrence replaces the first rather than adding
 * to it, so every denial has to be composed into this single comma-separated list.
 */
export function addClaudeNoSubagentArgs(args: string[], extraDenials: readonly string[] = []): void {
  args.push("--disallowedTools", ["Agent", "Task", ...extraDenials].join(","));
}
