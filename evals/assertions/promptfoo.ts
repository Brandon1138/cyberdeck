import { hardFailures } from "./invariants.js";
export default function assertEvidence(output: string) {
  try {
    const failures = hardFailures(JSON.parse(output));
    return { pass: failures.length === 0, score: failures.length ? 0 : 1, reason: failures.join(", ") || "Verified scenario evidence" };
  } catch { return { pass: false, score: 0, reason: "Invalid evidence JSON" }; }
}
