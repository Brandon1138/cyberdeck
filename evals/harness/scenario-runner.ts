import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { trustedGit } from "../../src/runtime/execution/trusted-git.js";
import { contentHash } from "../../src/runtime/execution/workspace-manifest.js";
import { scenarioId } from "../scenarios/catalog.js";
import { ScenarioEvidenceSchema, type EvalMode, type ScenarioEvidence } from "../assertions/evidence.js";
import { dirtyTreeScenario } from "./filesystem-scenario.js";
import { phantomTurnScenario, sentryOutageScenario } from "./turn-scenarios.js";
import { staleAuthorityScenario, maliciousTextScenario } from "./authority-scenarios.js";
import { timeoutScenario, backendScenario } from "./runtime-scenarios.js";
import { loadLiveEvalConfig, type LiveEvalConfig } from "./live-config.js";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";

type Provenance = "broker" | "host-verified" | "scripted" | "provider-native";
interface ScenarioResult {
  brokerId: string; image?: string | undefined; facts: unknown; checks: Record<string, boolean | undefined>; provenance?: Partial<Record<string, Provenance>>;
  expectedChangedPaths?: string[]; actualChangedPaths?: string[]; reportedChangedPaths?: string[]; unrelatedPathsChanged?: string[];
}
/** Closed scenario selection: model output and fixture prose never become shell code. */
export async function runScenario(value: unknown, mode: EvalMode = "offline-scripted", options: { live?: LiveEvalConfig } = {}): Promise<ScenarioEvidence> {
  const id = scenarioId(value);
  const live = mode === "live-container" ? options.live ?? await loadLiveEvalConfig() : undefined;
  // macOS Unix-domain sockets have a short path limit; scenario IDs belong in the
  // evidence manifest rather than in the socket's already-long temporary directory.
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-eval-"));
  const repository = fileURLToPath(new URL("../../", import.meta.url)), runId = randomUUID(), startedAt = new Date().toISOString();
  const commit = (await trustedGit(repository, ["rev-parse", "HEAD"])).toString().trim();
  const dirtyImplementation = (await trustedGit(repository, ["status", "--porcelain"])).length > 0;
  let result: ScenarioResult | undefined;
  const harnessErrors: string[] = [];
  try {
    result = id === "dirty-tree-false-completion" ? await dirtyTreeScenario(root, mode, live)
      : id === "phantom-turn" ? await phantomTurnScenario(root, mode, live)
      : id === "sentry-outage" ? await sentryOutageScenario(root, mode, live)
      : id === "stale-authority" ? await staleAuthorityScenario(root, mode, live)
      : id === "malicious-text" ? await maliciousTextScenario(root, mode, live)
      : id === "timeout" ? await timeoutScenario(root, mode, live) : await backendScenario(root, id === "oom" ? "oom" : "cross-worker", mode, live);
  } catch (error) { harnessErrors.push(error instanceof Error ? error.message : "UNKNOWN_HARNESS_ERROR"); }
  // Live command coverage is the provider-native tool evidence the recorder captured, read back
  // from the durable journal; a live row with no such evidence says so rather than inferring it.
  let nativeTools = 0;
  if (live) {
    try {
      const activity = await AgentActivityStore.open(join(root, "broker", "activity"));
      try {
        let after = 0;
        for (;;) { const page = await activity.read(result?.brokerId ?? runId, after, 1000); if (!page.length) break; after = page.at(-1)!.sequence; }
        const journal = (await readFile(join(root, "broker", "activity", "activity.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; provenance: string });
        nativeTools = journal.filter((event) => event.kind === "tool.invocation" && event.provenance === "provider-native").length;
      } finally { await activity.close(); }
    } catch { nativeTools = 0; }
  }
  const factsPath = join(root, "facts.json"), body = JSON.stringify({ result: result?.facts ?? null, harnessErrors, nativeTools });
  await writeFile(factsPath, body, { mode: 0o600 });
  const sha256 = contentHash(body);
  if (contentHash(await readFile(factsPath)) !== sha256) harnessErrors.push("EVIDENCE_HASH_MISMATCH");
  const evidence = ScenarioEvidenceSchema.parse({ schemaVersion: 1, runId, scenarioId: id, scenarioVersion: 1, mode,
    startedAt, finishedAt: new Date().toISOString(), commit, dirtyImplementation, brokerId: result?.brokerId ?? null,
    provider: live?.provider ?? "scripted", providerVersion: live ? `${live.provider}-in-image` : `fixture-v1/node-${process.versions.node}`, model: live?.model ?? "scripted-fixture",
    ...(result?.image ? { image: result.image } : {}),
    status: harnessErrors.length ? "failed" : "completed", captureComplete: result !== undefined && harnessErrors.length === 0,
    requiredCommandCoverage: id === "dirty-tree-false-completion", commandCoverage: live ? nativeTools > 0 ? "provider-native" : "unavailable" : "scripted",
    expectedChangedPaths: result?.expectedChangedPaths ?? [], actualChangedPaths: result?.actualChangedPaths ?? [],
    reportedChangedPaths: result?.reportedChangedPaths ?? [], unrelatedPathsChanged: result?.unrelatedPathsChanged ?? [],
    unauthorizedMutationCount: 0, missingInstructionIds: [], harnessErrors,
    checks: Object.entries(result?.checks ?? {}).map(([name, passed]) => ({ name, passed: passed === true, provenance: result?.provenance?.[name] ?? "scripted", evidenceRefs: ["facts"] })),
    artifacts: [{ id: "facts", path: factsPath, sha256 }], cleanup: result === undefined ? "retained-failure" : "complete",
    spend: { measuredUsd: null, authorizedCeilingUsd: live?.authorizedCeilingUsd ?? null,
      ...(live ? { billing: live.authentication && live.authentication.kind !== "api-key" ? "subscription" : "api" } : {}) },
  });
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  return evidence;
}
