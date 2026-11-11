import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexNativeAgentInventory } from "../../src/persistence/codex-native-agent-inventory.js";
import { CodexConversationBindingStore } from "../../src/persistence/codex-conversation-bindings.js";
import type { SessionRecord } from "../../src/domain/session.js";
import { CodexNativeAgentSources } from "../../src/persistence/codex-native-agent-sources.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const parentId = "11111111-1111-4111-8111-111111111111", nativeParent = "22222222-2222-4222-8222-222222222222";
const childId = "33333333-3333-4333-8333-333333333333";
const parent = { id: parentId, provider: "codex", kind: "orchestrator", name: "Configuration fixes", cwd: "/repo",
  createdAt: "2026-11-10T12:00:00.000Z", executionState: "active" } as SessionRecord;
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "native-agent-inventory-")); directories.push(home);
  const bindings = new CodexConversationBindingStore(home);
  await bindings.record({ sessionId: parentId, nativeSessionId: nativeParent, transcriptPath: join(home, "parent.jsonl"), cwd: "/repo" });
  const rollout = join(home, "child.jsonl");
  await writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: childId } }) + "\n"
    + JSON.stringify({ timestamp: "2026-11-10T12:01:00.000Z", type: "event_msg", payload: { type: "task_started" } }) + "\n");
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT, status TEXT); CREATE TABLE threads(id TEXT PRIMARY KEY, source TEXT, agent_path TEXT, rollout_path TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, model TEXT, reasoning_effort TEXT, archived INTEGER)");
  db.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,?)").run(nativeParent, childId, "open");
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)").run(childId,
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: nativeParent, agent_path: "/root/publication" } } }),
    "/root/publication", rollout, "/repo/publication", 1794312000, 1794312060, "gpt-6.1-sol", "xhigh", 0);
  db.close();
  return { home, bindings, rollout, inventory: new CodexNativeAgentInventory(home, bindings) };
}
it("projects exactly bound native workers without claiming broker ownership", async () => {
  const { inventory } = await fixture();
  const rows = await inventory.list([parent]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ record: { id: childId, name: "publication", parentSessionId: parentId },
    nativeAgent: { threadId: childId, parentThreadId: nativeParent, parentName: parent.name },
    runtimePresence: "unknown", workerTruth: { state: "working" } });
  expect(await inventory.list([{ ...parent, id: "44444444-4444-4444-8444-444444444444" }])).toEqual([]);
});
it("observes an ended turn as idle rather than task success", async () => {
  const { inventory, rollout } = await fixture();
  await writeFile(rollout, JSON.stringify({ timestamp: "2026-11-10T12:02:00.000Z", type: "event_msg", payload: { type: "task_complete" } }) + "\n", { flag: "a" });
  expect((await inventory.list([parent]))[0]?.workerTruth).toMatchObject({ state: "idle", taskOutcome: "unknown" });
});
it("retains discovered workers explicitly unavailable when their source fails", async () => {
  const { inventory, home } = await fixture();
  await inventory.list([parent]);
  await rm(join(home, "state_5.sqlite"));
  const rows = await inventory.list([parent]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.workerTruth).toMatchObject({ state: "unknown", lastConfirmed: { state: "working" } });
  expect(inventory.notice).toContain("unavailable");
  expect(rows[0]?.workerTruth?.detail).toContain("last confirmed working");
});
it("rejects a source whose parent identity disagrees with the edge", async () => {
  const { inventory, home } = await fixture();
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.prepare("UPDATE threads SET source=?").run(JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "foreign", agent_path: "/root/publication" } } })); db.close();
  expect(await inventory.list([parent])).toEqual([]);
});
it("reads real-sized native metadata and keeps activity through large tool output", async () => {
  const { inventory, rollout } = await fixture();
  await writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: childId, instructions: "x".repeat(24_000) } }) + "\n"
    + JSON.stringify({ timestamp: "2026-11-10T12:01:00.000Z", type: "event_msg", payload: { type: "task_started" } }) + "\n");
  expect((await inventory.list([parent]))[0]?.workerTruth?.state).toBe("working");
  await writeFile(rollout, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(200_000) } }) + "\n", { flag: "a" });
  expect((await inventory.list([parent]))[0]?.workerTruth?.state).toBe("working");
});
it("marks corrupt complete native frames unavailable instead of retaining Working", async () => {
  const { inventory, rollout } = await fixture();
  await inventory.list([parent]);
  await writeFile(rollout, '{"type":"event_msg","payload":{"type":"task_complete"}\n', { flag: "a" });
  expect((await inventory.list([parent]))[0]?.workerTruth?.state).toBe("unknown");
  expect((await inventory.list([parent]))[0]?.workerTruth?.state).toBe("unknown");
});
it("retains known workers when the exact binding temporarily disappears", async () => {
  const { inventory, bindings } = await fixture();
  await inventory.list([parent]);
  await bindings.remove(parentId);
  const rows = await inventory.list([parent]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.workerTruth?.state).toBe("unknown");
  expect(inventory.notice).toContain("unavailable");
});
it("discovers ordinary worker children from their own Codex home alongside orchestrator children", async () => {
  const orchestrator = await fixture(), ordinary = await fixture();
  const workerId = "66666666-6666-4666-8666-666666666666", workerNative = "77777777-7777-4777-8777-777777777777";
  const workerChild = "88888888-8888-4888-8888-888888888888";
  await orchestrator.bindings.record({ sessionId: workerId, nativeSessionId: workerNative, transcriptPath: join(ordinary.home, "worker.jsonl"), cwd: "/repo" });
  const db = new DatabaseSync(join(ordinary.home, "state_5.sqlite"));
  db.prepare("UPDATE thread_spawn_edges SET parent_thread_id=?,child_thread_id=?").run(workerNative, workerChild);
  db.prepare("UPDATE threads SET id=?,source=?,agent_path=?").run(workerChild,
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: workerNative, agent_path: "/root/services" } } }), "/root/services"); db.close();
  await writeFile(ordinary.rollout, JSON.stringify({ type: "session_meta", payload: { id: workerChild } }) + "\n"
    + JSON.stringify({ timestamp: "2026-11-10T12:02:00.000Z", type: "event_msg", payload: { type: "task_started" } }) + "\n");
  const sources = new CodexNativeAgentSources({ orchestratorHome: orchestrator.home, workerHome: ordinary.home, bindings: orchestrator.bindings });
  const worker = { ...parent, id: workerId, kind: "worker", name: "Ordinary worker" } as SessionRecord;
  const rows = await sources.list([parent, worker]);
  expect(rows.map(row => row.record.name).sort()).toEqual(["publication", "services"]);
  expect(rows.find(row => row.record.id === workerChild)).toMatchObject({ record: { parentSessionId: workerId }, workerTruth: { state: "working" } });
  await rm(join(ordinary.home, "state_5.sqlite"));
  const partial = await sources.list([parent, worker]);
  expect(partial.find(row => row.record.id === childId)?.workerTruth?.state).toBe("working");
  expect(partial.find(row => row.record.id === workerChild)?.workerTruth?.state).toBe("unknown");
  expect(sources.notice).toContain("unavailable");
});
