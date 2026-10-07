import { dirname, resolve } from "node:path";
import { assessResourceFleetEvidence } from "../evals/assertions/resource-fleet-evidence.js";
import { readBoundedEvidenceFile, verifyResourceFleetArtifacts } from "../evals/assertions/resource-fleet-artifacts.js";

const [manifestPath, expectedPath, ...extra] = process.argv.slice(2);
try {
  if (!manifestPath || !expectedPath || extra.length) throw new Error("usage");
  const [manifest, expected] = await Promise.all([
    readBoundedEvidenceFile(resolve(manifestPath), 32 * 1024 ** 2), readBoundedEvidenceFile(resolve(expectedPath), 4096),
  ]);
  const raw: unknown = JSON.parse(manifest.toString("utf8"));
  const assessment = assessResourceFleetEvidence(raw, JSON.parse(expected.toString("utf8")));
  const artifactFailures = assessment.failures.includes("schema-invalid") ? [] : await verifyResourceFleetArtifacts(raw, dirname(resolve(manifestPath)));
  const status = artifactFailures.length ? "failed" : assessment.status === "structurally-consistent" ? "evidence-consistent" : assessment.status;
  console.log(JSON.stringify({ ...assessment, status, artifactFailures, artifactHashesVerified: !artifactFailures.length && assessment.status === "structurally-consistent" }));
  if (status !== "evidence-consistent") process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ status: "unverified", failures: ["evidence-input-unavailable-or-invalid"],
    usage: "verify-resource-evidence.ts <manifest.json> <expected-candidate.json>" }));
  process.exitCode = 1;
}
