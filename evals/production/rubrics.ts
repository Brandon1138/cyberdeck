/** Host-owned rubric catalogue. Checks must be produced by independent verifiers of pinned
 * artifacts, never inferred from provider prose. Version changes create new evaluation rows. */
export const productionRubrics = {
  "constrained-edit": { version: "1", checks: ["allowed-path-diff", "acceptance-tests", "regression-tests"] },
  "bug-fix": { version: "1", checks: ["reproduces-before", "fixed-after", "regression-tests"] },
  "repository-review": { version: "1", checks: ["ground-truth-findings", "no-fabricated-findings", "location-accuracy"] },
  "planning": { version: "1", checks: ["requirement-coverage", "dependency-order", "verifiable-exit-criteria"] },
} as const;
