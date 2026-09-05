import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedGit } from "../../src/runtime/execution/trusted-git.js";
import { contentHash } from "../../src/runtime/execution/workspace-manifest.js";
import { scenarioId } from "../scenarios/catalog.js";
import { ScenarioEvidenceSchema, type ScenarioEvidence } from "../assertions/evidence.js";
import { dirtyTreeScenario } from "./filesystem-scenario.js";
import { phantomTurnScenario, sentryOutageScenario } from "./turn-scenarios.js";
import { staleAuthorityScenario, maliciousTextScenario } from "./authority-scenarios.js";
import { timeoutScenario, backendScenario } from "./runtime-scenarios.js";

/** Closed scenario selection: model output and fixture prose never become shell code. */
export async function runScenario(value: unknown, mode: "offline-scripted" | "live-container" = "offline-scripted"): Promise<ScenarioEvidence> {
  const id = scenarioId(value);
  if (mode !== "offline-scripted") throw new Error("LIVE_EVAL_REQUIRES_AUTHORIZED_CONFIG_AND_NATIVE_CAPTURE");
  // macOS Unix-domain sockets have a short path limit; scenario IDs belong in the
  // evidence manifest rather than in the socket's already-long temporary directory.
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-eval-"));
  const repository = fileURLToPath(new URL("../../", import.meta.url)), runId = randomUUID(), startedAt = new Date().toISOString();
  const commit = (await trustedGit(repository, ["rev-parse", "HEAD"])).toString().trim();
  const dirtyImplementation = (await trustedGit(repository, ["status", "--porcelain"])).length > 0;
  let result: { brokerId: string; facts: unknown; checks: Record<string, boolean | undefined>; expectedChangedPaths?: string[]; actualChangedPaths?: string[]; reportedChangedPaths?: string[]; unrelatedPathsChanged?: string[] } | undefined;
  const harnessErrors: string[] = [];
  try {
    result = id === "dirty-tree-false-completion" ? await dirtyTreeScenario(root)
      : id === "phantom-turn" ? await phantomTurnScenario(root)
      : id === "sentry-outage" ? await sentryOutageScenario(root)
      : id === "stale-authority" ? await staleAuthorityScenario(root)
      : id === "malicious-text" ? await maliciousTextScenario(root)
      : id === "timeout" ? await timeoutScenario(root) : await backendScenario(root, id === "oom" ? "oom" : "cross-worker");
  } catch (error) { harnessErrors.push(error instanceof Error ? error.message : "UNKNOWN_HARNESS_ERROR"); }
  const factsPath = join(root, "facts.json"), body = JSON.stringify({ result: result?.facts ?? null, harnessErrors });
  await writeFile(factsPath, body, { mode: 0o600 });
  const sha256 = contentHash(body);
  if (contentHash(await readFile(factsPath)) !== sha256) harnessErrors.push("EVIDENCE_HASH_MISMATCH");
  const evidence = ScenarioEvidenceSchema.parse({ schemaVersion: 1, runId, scenarioId: id, scenarioVersion: 1, mode,
    startedAt, finishedAt: new Date().toISOString(), commit, dirtyImplementation, brokerId: result?.brokerId ?? null,
    provider: "scripted", providerVersion: `fixture-v1/node-${process.versions.node}`, model: "scripted-fixture",
    status: harnessErrors.length ? "failed" : "completed", captureComplete: result !== undefined && harnessErrors.length === 0,
    requiredCommandCoverage: id === "dirty-tree-false-completion", commandCoverage: "scripted",
    expectedChangedPaths: result?.expectedChangedPaths ?? [], actualChangedPaths: result?.actualChangedPaths ?? [],
    reportedChangedPaths: result?.reportedChangedPaths ?? [], unrelatedPathsChanged: result?.unrelatedPathsChanged ?? [],
    unauthorizedMutationCount: 0, missingInstructionIds: [], harnessErrors,
    checks: Object.entries(result?.checks ?? {}).map(([name, passed]) => ({ name, passed: passed === true, provenance: "scripted", evidenceRefs: ["facts"] })),
    artifacts: [{ id: "facts", path: factsPath, sha256 }], cleanup: result === undefined ? "retained-failure" : "complete",
    spend: { measuredUsd: null, authorizedCeilingUsd: null },
  });
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  return evidence;
}
