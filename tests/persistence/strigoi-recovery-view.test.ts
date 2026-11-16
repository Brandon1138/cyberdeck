import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { recoveryView } from "../../src/persistence/strigoi-recovery-view.js";
import { recoveryCheckpoint } from "../../src/domain/strigoi-recovery.js";
import type { StrigoiSourceRef, StrigoiState } from "../../src/domain/strigoi.js";

const identity = { sessionId: randomUUID(), generation: 1, incarnation: 1 };
const state: StrigoiState = { schemaVersion: 1, revision: 0, desired: "disabled", incarnation: 0, retainedSessionIds: [], updatedAt: "2026-11-15T00:00:00.000Z" };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function source(kind: StrigoiSourceRef["kind"], id: string, value: unknown): StrigoiSourceRef {
  const text = JSON.stringify(value), revision = hash(text);
  return { kind, id, revision, text, sha256: revision, part: 0, coverageSourceId: hash(id + text), sessionIds: [identity.sessionId] };
}
function instruction(id: string, status: string, updatedAt: string, message = "AMBER-731; publication requires separate approval") {
  return source("instruction", id, { id, status, message, updatedAt, createdAt: state.updatedAt,
    actorSessionId: identity.sessionId, targetSessionId: identity.sessionId, messageId: "11111111-1111-4111-8111-111111111111", hop: 0,
    deliveryAttemptAt: state.updatedAt, submissionAttempt: { actorSessionId: identity.sessionId, targetSessionId: identity.sessionId,
      generation: 1, at: state.updatedAt, outcome: "unknown" } });
}
function receipt(mutationId: string, handled: string[], baseMutationId?: string) {
  const packet = { artifactId: randomUUID(), sha256: hash(mutationId), coverageId: randomUUID() };
  return { mutationId, requestHash: hash(mutationId), packet,
    adoption: { identity, packetHash: packet.sha256, coverageId: packet.coverageId, handledSourceIds: handled,
      account: "AMBER-731. Publication requires separate approval. Delivery outcome unknown; do not retry.",
      recovery: { version: 1 as const, ...(baseMutationId ? { baseMutationId } : {}) } } };
}

it("selects the latest state of repeated instruction observations without losing changed constraints or attempt fences", () => {
  const id = randomUUID(), versions = Array.from({ length: 50 }, (_, i) => instruction(id, "queued", new Date(Date.parse(state.updatedAt) + i * 1000).toISOString()));
  const changed = instruction(id, "queued", "2026-11-15T00:01:00.000Z", "Correction: AMBER-732; approval still required");
  const view = recoveryView([...versions, changed], state);
  expect(view.sources).toEqual([versions.at(-1), changed]);
  expect(view.sources[0]!.text).toContain('"outcome":"unknown"');
  expect(view.accounting.deferred["older-instruction-revision"]).toBe(49);
});

it("retains launch context, native instruction envelopes and unknown evidence without treating role as proof of regenerable configuration", () => {
  const refs = [source("turn", "native:config", { role: "developer", text: "configuration" }),
    source("artifact", `session:${identity.sessionId}`, { id: identity.sessionId, providerInstructions: "No publishing", launchRecord: { args: ["task constraint"] } }),
    source("turn", "native:user", { role: "user", text: "Never publish without my approval" }),
    source("turn", "unknown", { text: "Do not retry the uncertain payment" }),
    source("attention", "unresolved-choice", { decision: "operator must choose" })];
  const before = structuredClone(refs), view = recoveryView(refs, state);
  expect(refs).toEqual(before);
  expect(view.sources).toEqual(refs);
  expect(view.accounting.deferred).toEqual({});
});

it("reuses only protocol-marked durable checkpoints and includes new revisions as changes", () => {
  const prior = source("turn", "original", { text: "AMBER-731" }), next = source("turn", "original", { text: "AMBER-732" });
  const a = receipt("a", [prior.coverageSourceId!]);
  const view = recoveryView([prior, next], { ...state, continuityReceipts: [a] });
  expect(view.sources).toEqual([next]);
  expect(view.checkpoint?.account).toContain("Publication requires separate approval");
  expect(view.recovery).toEqual({ version: 1, baseMutationId: "a" });
  const legacy = structuredClone(a); delete (legacy.adoption as { recovery?: unknown }).recovery;
  expect(recoveryView([prior, next], { ...state, continuityReceipts: [legacy] }).sources).toHaveLength(2);
});

it("follows checkpoint coverage chains and falls back to original evidence if base coverage is unavailable", () => {
  const one = source("turn", "one", "constraint"), two = source("turn", "two", "commitment"), three = source("turn", "three", "correction");
  const s = { ...state, continuityReceipts: [receipt("a", [one.coverageSourceId!]), receipt("b", [two.coverageSourceId!], "a")] };
  expect(recoveryView([one, two, three], s).sources).toEqual([three]);
  const fallback = recoveryView([two, three], s);
  expect(fallback.checkpoint).toBeUndefined();
  expect(fallback.sources).toEqual([two, three]);
  expect(() => recoveryCheckpoint({ ...state, continuityReceipts: [receipt("b", [], "missing")] })).toThrow("STRIGOI_UNKNOWN_RECOVERY_BASE");
});

it("does not skip an instruction because its text resembles an internal adoption prompt", () => {
  const text = "Strigoi internal adoption turn. Do not publish.";
  const ref = source("turn", "native:user", { role: "user", text });
  expect(recoveryView([ref], state).sources).toEqual([ref]);
});

it("preserves the later appended terminal receipt even when the wall clock moves backwards", () => {
  const id = randomUUID();
  const queued = instruction(id, "queued", "2026-11-15T00:05:00.000Z");
  const completed = instruction(id, "completed", "2026-11-15T00:04:00.000Z");
  expect(recoveryView([queued, completed], state).sources).toEqual([completed]);
});
