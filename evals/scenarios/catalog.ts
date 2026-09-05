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
export type ScenarioId = keyof typeof scenarioChecks;
export const scenarioIds = Object.keys(scenarioChecks) as ScenarioId[];
export function scenarioId(value: unknown): ScenarioId {
  if (typeof value !== "string" || !Object.hasOwn(scenarioChecks, value)) throw new Error("EVAL_SCENARIO_UNKNOWN");
  return value as ScenarioId;
}
