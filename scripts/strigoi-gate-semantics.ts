import { readFile } from "node:fs/promises";
export interface SemanticCase {
  id: string;
  execution: { inputs: string[]; continuation: string; handoffs: number; prefix: string };
}
export async function semanticCase(id: string | undefined): Promise<SemanticCase> {
  const rubric = JSON.parse(await readFile(new URL("../tests/fixtures/strigoi/semantic-cases.json", import.meta.url), "utf8")) as { cases: SemanticCase[] };
  const selected = rubric.cases.find(c => c.id === id);
  if (!selected) throw new Error("Unknown semantic case; select an exact rubric case ID");
  return selected;
}

/** The fixed sequence and matching live ports make all seven pairs executable; no model
 * scores or generated test conversations are accepted as evidence of semantic success. */
export async function runSemanticPair(selected: SemanticCase, ports: {
  submit(arm: "resident" | "baseline", text: string): Promise<unknown>;
  renew(reason: string): Promise<unknown>;
  save(evidence: unknown): Promise<void>;
}) {
  const evidence = { caseId: selected.id, status: "INCOMPLETE", humanReview: "NOT RUN", score: null, noHandoffScore: null,
    reviewer: null, date: null, actionDifferences: null, verdictRationale: null,
    steps: [] as { kind: string; arm?: string; prompt?: string; receipt?: unknown; renewal?: unknown }[] };
  await ports.save(evidence);
  const pair = async (message: string) => {
    const prompt = selected.execution.prefix + message;
    for (const arm of ["resident", "baseline"] as const) {
      const receipt = await ports.submit(arm, prompt);
      evidence.steps.push({ kind: "conversation", arm, prompt, receipt }); await ports.save(evidence);
    }
  };
  for (const message of selected.execution.inputs) await pair(message);
  for (let n = 1; n <= selected.execution.handoffs; n++) {
    const renewal = await ports.renew(`semantic:${selected.id}:${n}`);
    evidence.steps.push({ kind: "handoff", renewal }); await ports.save(evidence);
    await pair(selected.execution.continuation);
  }
  evidence.status = "PAIR_CAPTURED_HUMAN_REVIEW_REQUIRED"; await ports.save(evidence);
  return evidence;
}
