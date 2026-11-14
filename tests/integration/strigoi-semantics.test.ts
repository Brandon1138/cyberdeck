import { expect, it } from "vitest";
import { semanticCase, runSemanticPair } from "../../scripts/strigoi-gate-semantics.js";

const ids = ["alfred", "changed-instruction", "unresolved-choice", "stale-evidence", "delegated-vs-personal", "uncertain-effect", "three-handoffs"];
it.each(ids)("executes matched semantic pair %s with bounded renewals, human verdict pending", async id => {
  const selected = await semanticCase(id), prompts = { resident: [] as string[], baseline: [] as string[] }, renewals: string[] = [];
  let saved: unknown;
  const evidence = await runSemanticPair(selected, {
    submit: async (arm, text) => { prompts[arm].push(text); return { id: `${arm}:${prompts[arm].length}`, synthetic: true }; },
    renew: async reason => { renewals.push(reason); return { transitionId: reason }; },
    save: async value => { saved = structuredClone(value); },
  });
  expect(prompts.resident).toEqual(prompts.baseline);
  expect(prompts.resident).toHaveLength(selected.execution.inputs.length + selected.execution.handoffs);
  expect(renewals).toHaveLength(id === "three-handoffs" ? 3 : 1);
  expect(evidence.steps.filter(s => s.kind === "handoff")).toHaveLength(renewals.length);
  for (const [i, step] of evidence.steps.entries()) if (step.kind === "handoff") {
    expect(evidence.steps[i + 1]).toMatchObject({ arm: "resident", prompt: selected.execution.prefix + selected.execution.continuation });
    expect(evidence.steps[i + 2]).toMatchObject({ arm: "baseline", prompt: selected.execution.prefix + selected.execution.continuation });
  }
  expect(saved).toMatchObject({ status: "PAIR_CAPTURED_HUMAN_REVIEW_REQUIRED", humanReview: "NOT RUN", score: null, noHandoffScore: null });
});
it("retains incomplete pair when renewal fails; never manufactures matching outputs or scores", async () => {
  const selected = await semanticCase("alfred"); let saved: unknown;
  await expect(runSemanticPair(selected, { submit: async () => ({ receipt: "seed" }), renew: async () => { throw new Error("held"); },
    save: async value => { saved = structuredClone(value); } })).rejects.toThrow("held");
  expect(saved).toMatchObject({ status: "INCOMPLETE", humanReview: "NOT RUN", steps: [{ arm: "resident" }, { arm: "baseline" }] });
});
it("rejects unknown or omitted cases", async () => {
  await expect(semanticCase("adapt-later")).rejects.toThrow("Unknown semantic case");
  await expect(semanticCase(undefined)).rejects.toThrow("Unknown semantic case");
});
