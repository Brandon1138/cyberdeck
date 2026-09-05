export const scenarioChecks = {
  "dirty-tree-false-completion": ["unrelated-tracked-preserved", "unrelated-untracked-preserved", "expected-change", "reported-changes-truthful", "dirty-source-preserved"],
  "phantom-turn": ["distinct-instructions", "late-turn-not-reused", "second-instruction-completed"],
  "stale-authority": ["handoff-committed", "stale-authority-fenced", "handoff-atomic"],
  "malicious-text": ["text-grants-no-authority", "operator-method-refused", "wrong-worker-refused"],
  "timeout": ["guest-or-scripted-process-stopped", "capacity-released", "evidence-retained"],
  "oom": ["oom-classified", "capacity-released", "evidence-retained"],
  "sentry-outage": ["delivery-with-failing-sink", "local-evidence-durable", "settlement-with-failing-sink"],
  "cross-worker": ["private-workspaces", "other-worker-not-mounted", "credentials-not-shared"],
} as const;
/** Checks that only a real container can answer. Required in every container-backed mode. */
export const containerChecks: Partial<Record<ScenarioId, readonly string[]>> = {
  "dirty-tree-false-completion": ["report-through-gateway"],
  "malicious-text": ["guest-probe-refused"],
  "timeout": ["guest-stopped-by-deadline"],
  "oom": ["real-cgroup-oom"],
  "cross-worker": ["other-worker-unavailable"],
};
export type ScenarioId = keyof typeof scenarioChecks;
export const scenarioIds = Object.keys(scenarioChecks) as ScenarioId[];
export function scenarioId(value: unknown): ScenarioId {
  if (typeof value !== "string" || !Object.hasOwn(scenarioChecks, value)) throw new Error("EVAL_SCENARIO_UNKNOWN");
  return value as ScenarioId;
}
export function requiredChecks(id: ScenarioId, mode: string): readonly string[] {
  return mode === "offline-scripted" ? scenarioChecks[id] : [...scenarioChecks[id], ...(containerChecks[id] ?? [])];
}
