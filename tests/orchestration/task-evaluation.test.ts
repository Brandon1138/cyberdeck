import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentActivity } from "../../src/domain/agent-activity.js";
import { TaskEvaluationService } from "../../src/orchestration/task-evaluation-service.js";
import { TaskEvaluationStore, evidenceHash, type EvaluationClaim, type EvaluationEvidenceManifest } from "../../src/persistence/task-evaluation-store.js";
import { evaluateEvidence, evaluateNext } from "../../evals/production/evaluate-attempt.js";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const event = (overrides: Partial<AgentActivity> = {}): AgentActivity => ({ schemaVersion: 1, eventId: randomUUID(), sequence: 1, sourceKey: "terminal", runId: randomUUID(), workerId: randomUUID(), sessionId: randomUUID(), generation: 1, observedAt: new Date().toISOString(), kind: "provider.turn", provenance: "provider-native", coverage: "complete-for-source", operation: "agent", outcome: "succeeded", origin: "direct-input", ...overrides });
const evidence = (e: AgentActivity): EvaluationEvidenceManifest => ({ schemaVersion: 1, terminalEvent: e, checks: [], complete: false, metadata: { modelSource: "unknown" } });
function setup() { const dir = mkdtempSync(join(tmpdir(), "eval-service-")); dirs.push(dir); return new TaskEvaluationStore(join(dir, "db")); }
test("canonical settlement replay recovers crash before enqueue across terminal origins", async () => {
  const store = setup(); const service = new TaskEvaluationService(store, { capture: async e => ({ generation: e.generation!, manifest: evidence(e) }) }, { id: "task", version: "1" });
  const events = [event(), event({ origin: "initial-prompt" }), event({ origin: "unattributed" }), event({ kind: "instruction.cancelled", instructionId: randomUUID(), outcome: "cancelled" }), event({ kind: "instruction.undelivered", instructionId: randomUUID(), outcome: "failed" }), event({ kind: "execution.lifecycle", outcome: "failed" })];
  async function* journal() { yield* events; }
  await service.reconcile(journal()); await service.reconcile(journal());
  expect(store.health().pending).toBe(6);
  await service.observeTerminal(event({ provenance: "worker-report" })); expect(store.health().pending).toBe(6);
  await expect(service.observeTerminal(event({ generation: undefined } as unknown as Partial<AgentActivity>))).rejects.toThrow("GENERATION_UNKNOWN"); store.close();
});
test("missing rubric/evidence and malicious worker claims cannot pass; cancellation distinct", () => {
  const manifest = evidence(event());
  const claim = { intent: { evidenceManifestHash: evidenceHash(manifest) }, manifest } as EvaluationClaim;
  expect(evaluateEvidence(claim).disposition).toBe("unverified");
  manifest.complete = true; manifest.checks = [{ id: "tests", passed: true, source: "worker-report" as "host-verified", artifactHash: "a".repeat(64) }];
  claim.intent.evidenceManifestHash = evidenceHash(manifest);
  expect(evaluateEvidence(claim, ["tests"]).disposition).toBe("unverified");
  manifest.checks[0]!.source = "host-verified"; manifest.checks[0]!.passed = false; claim.intent.evidenceManifestHash = evidenceHash(manifest);
  expect(evaluateEvidence(claim, ["tests"]).disposition).toBe("verified-fail");
  manifest.terminalEvent = { outcome: "cancelled" }; claim.intent.evidenceManifestHash = evidenceHash(manifest);
  expect(evaluateEvidence(claim, ["tests"]).disposition).toBe("cancelled");
});
test("resource wait never starts evaluator; process failure is infrastructure only", async () => {
  const store = setup(), service = new TaskEvaluationService(store, { capture: async e => ({ generation: 1, manifest: evidence(e) }) }, { id: "task", version: "1" }); await service.observeTerminal(event());
  const runner = { run: vi.fn(async () => ({ exitCode: 1, timedOut: false, output: "PASS", terminationEvidenceId: "exit" })) };
  const demand = { memoryBytes: 1024, cpuWeight: 1, pidLimit: 4, profileId: "evaluation", profileVersion: "1" };
  const request = { requestId: "eval", owner: { installationId: "test", workloadId: "eval", kind: "evaluation" as const }, demand, priority: "background" as const };
  const release = vi.fn(async () => {});
  await evaluateNext(store, { request: async () => ({ state: "waiting-capacity", reason: "full", queuedAt: "now" }), release, cancel: async () => {} }, request, runner);
  expect(runner.run).not.toHaveBeenCalled();
  await evaluateNext(store, { request: async () => ({ state: "admitted", reservationId: "r", demand }), release, cancel: async () => {} }, request, runner, () => 0);
  expect(release).toHaveBeenCalledOnce(); expect(store.health().pending).toBe(0); store.close();
});
