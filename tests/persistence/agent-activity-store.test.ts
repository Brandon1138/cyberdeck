import { randomUUID } from "node:crypto";
import { mkdtemp, rm, appendFile, writeFile, readFile } from "node:fs/promises";
import { vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentActivityStore } from "../../src/persistence/agent-activity-store.js";
import type { ActivityInput } from "../../src/domain/agent-activity.js";
import { collectNativeActivity } from "../../src/runtime/activity/provider-activity-collector.js";
import { codexActivity } from "../../src/runtime/activity/codex-activity.js";
import { claudeActivity } from "../../src/runtime/activity/claude-activity.js";
let failNextSync = false;
vi.mock("../../src/persistence/private-files.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/persistence/private-files.js")>();
  return { ...original, openPrivateAppendFile: async (path: string) => {
    const handle = await original.openPrivateAppendFile(path);
    if (!failNextSync) return handle;
    failNextSync = false;
    return new Proxy(handle, { get: (target, key) => key === "sync" ? async () => { throw new Error("sync-failed"); } : Reflect.get(target, key) });
  } };
});
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "cyberdeck-activity-")); directories.push(path); return path; }
function input(): ActivityInput {
  const id = randomUUID(); return { schemaVersion: 1, eventId: randomUUID(), sourceKey: id, runId: id, workerId: id, sessionId: id,
    observedAt: new Date().toISOString(), kind: "instruction.queued", operation: "instruction", provenance: "broker", coverage: "complete-for-source", outcome: "observed" };
}
it("orders concurrent writes durably and deduplicates source frames through restart", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path), event = input();
  const result = await Promise.all([store.append(event), store.append(event), store.append({ ...event, eventId: randomUUID(), sourceKey: "second" })]);
  expect(result.map((e) => e.sequence)).toEqual([1, 1, 2]);
  const recovered = await AgentActivityStore.open(path);
  expect((await recovered.append(event)).sequence).toBe(1);
  expect(await recovered.read(event.runId, 0, 100)).toHaveLength(2);
  await expect(recovered.append({ ...event, instructionId: randomUUID() })).rejects.toThrow("ACTIVITY_ATTRIBUTION_CONFLICT");
});
it("exposes byte retention loss through restart and rejects unbounded pages", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path, { maxBytes: 16000, maxAgeMs: 86400000 });
  for (let i = 0; i < 40; i++) await store.append(input());
  const health = store.health();
  expect(health.degraded).toBe(true);
  expect(health.indexBytes).toBeGreaterThan(0);
  expect(health.journalBytes + health.indexBytes).toBeLessThanOrEqual(health.capBytes);
  const recovered = await AgentActivityStore.open(path);
  expect(recovered.health().dropped).toBeGreaterThan(0);
  await expect(recovered.read(randomUUID(), 0, 1001)).rejects.toThrow("ACTIVITY_READ_LIMIT");
});
it("preserves torn tails and reports recording degradation", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path);
  await store.append(input()); await appendFile(join(path, "activity.jsonl"), '{"torn":');
  const recovered = await AgentActivityStore.open(path);
  expect(recovered.health()).toMatchObject({ degraded: true, dropped: 1, retained: 1 });
  await recovered.append(input());
  expect((await AgentActivityStore.open(path)).health().retained).toBe(2);
});
it("retains tool call IDs with source provenance and detects conflicting turn attribution", async () => {
  const store = await AgentActivityStore.open(await directory()), base = input();
  const attribution = { runId: base.runId, workerId: base.workerId, sessionId: base.sessionId, generation: 2, instructionId: randomUUID(), providerTurnId: "turn-a", origin: "instruction" as const };
  const frames = [
    { type: "response_item", payload: { type: "function_call", call_id: "call-a", arguments: "SENSITIVE_ARGUMENT" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-a", output: "SENSITIVE_RESULT", turn_id: "turn-b" } },
  ];
  await collectNativeActivity({ provider: "codex", sourceId: "fixture", attribution, recorder: store, parse: codexActivity,
    lines: frames.map((frame, offset) => ({ offset, text: JSON.stringify(frame) })) });
  const events = await store.read(base.runId, 0, 100);
  expect(events[0]).toMatchObject({ kind: "tool.invocation", toolCallId: "call-a", instructionId: attribution.instructionId });
  expect(events[1]).toMatchObject({ kind: "capture.gap", gap: "attribution-conflict" });
  expect(JSON.stringify(events)).not.toContain("SENSITIVE_");
  expect(claudeActivity({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "tool_use", id: "call-b", input: { secret: true } }] } })).toEqual([{ kind: "tool.invocation", toolCallId: "call-b" }]);
});

it("retains pinned incident evidence across reopen and fails visibly at the byte cap", async () => {
  const path = await directory(), event = input();
  const store = await AgentActivityStore.open(path, { maxBytes: 10000, maxAgeMs: 86400000 });
  await store.append(event); await store.pin(event.runId, true); await store.close();
  const reopened = await AgentActivityStore.open(path, { maxBytes: 10000, maxAgeMs: 86400000 });
  expect(reopened.health().pinned).toBe(1);
  let refused: unknown;
  for (let i = 0; i < 50 && refused === undefined; i++) await reopened.append(input()).catch((error: unknown) => { refused = error; });
  expect(String(refused)).toContain("ACTIVITY_PINNED_CAPACITY");
  expect((await reopened.read(event.runId, 0, 100))[0]?.eventId).toBe(event.eventId);
  expect(reopened.health().degraded).toBe(true);
  await reopened.pin(event.runId, false); await reopened.append(input());
  expect(await reopened.read(event.runId, 0, 100)).toEqual([]);
  await reopened.close();
});
it("reads exact pages while writes compact the journal and rebuilds its disk index", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path, { maxBytes: 12000, maxAgeMs: 86400000 });
  const original = input();
  for (let i = 0; i < 20; i++) {
    await Promise.all([store.append({ ...original, sourceKey: `offset-${i}`, eventId: randomUUID() }), store.read(original.runId, 0, 100)]);
  }
  const before = await store.read(original.runId, 0, 100); await store.close();
  const rebuilt = await AgentActivityStore.open(path);
  expect(await rebuilt.read(original.runId, 0, 100)).toEqual(before);
  expect(before.every((event, index) => index === 0 || event.sequence > before[index - 1]!.sequence)).toBe(true);
  await rebuilt.close();
});

it("joins runs for one session in ingestion order without admitting another session", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path), event = input();
  await store.append(event);
  await store.append(input());
  await store.append({ ...event, eventId: randomUUID(), sourceKey: "other-run", runId: randomUUID(), kind: "worker.handoff" });
  expect((await store.readSession(event.sessionId, 0, 100)).map((record) => record.sequence)).toEqual([1, 3]);
  expect((await store.readSession(event.sessionId, 1, 1)).map((record) => record.sequence)).toEqual([3]);
  await expect(store.readSession(event.sessionId, -1, 100)).rejects.toThrow("ACTIVITY_READ_CURSOR");
  await store.close();
  const reopened = await AgentActivityStore.open(path);
  expect((await reopened.readSession(event.sessionId, 0, 100)).map((record) => record.sequence)).toEqual([1, 3]);
  await reopened.close();
});

it("starts over a corrupt disposable index and never lets it decide what the journal holds", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path), event = input();
  await store.append(event); await store.close();
  await writeFile(join(path, "activity-index.sqlite"), "not a database at all");
  await writeFile(join(path, "activity-index.sqlite-journal"), "stale rollback journal");
  const recovered = await AgentActivityStore.open(path);
  expect(recovered.health()).toMatchObject({ degraded: false, retained: 1 });
  expect((await recovered.read(event.runId, 0, 100))[0]?.eventId).toBe(event.eventId);
  await recovered.close();
});
it("re-reads its journal after a failed write instead of staying unavailable, and counts the loss", async () => {
  const path = await directory(), store = await AgentActivityStore.open(path), first = input();
  await store.append(first);
  failNextSync = true;
  await expect(store.append(input())).rejects.toThrow("sync-failed");
  expect(store.health().uncertain).toBe(true);
  const second = input(), appended = await store.append(second);
  expect(appended.sequence).toBeGreaterThan(1);
  expect(store.health()).toMatchObject({ uncertain: false, degraded: true });
  expect(store.health().dropped).toBeGreaterThanOrEqual(1);
  expect((await store.read(first.runId, 0, 100))[0]?.eventId).toBe(first.eventId);
  // The unsynced line may or may not have reached the file; either way the loss counter only overreports.
  const lines = (await readFile(join(path, "activity.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).eventId);
  expect(lines[0]).toBe(first.eventId); expect(lines.at(-1)).toBe(second.eventId);
  expect(store.health().retained).toBe(lines.length);
  await store.close();
});
