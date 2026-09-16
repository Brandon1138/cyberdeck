import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { TaskEvaluationStore } from "../../src/persistence/task-evaluation-store.js";
import { auditTerminalInstructions } from "../../src/orchestration/task-evaluation-reconciliation.js";
import type { LegacyInstructionSnapshot } from "../../src/orchestration/task-evaluation-legacy.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const path = () => { const dir = mkdtempSync(join(tmpdir(), "legacy-evaluation-")); dirs.push(dir); return join(dir, "db"); };
const record = (status = "completed") => ({ id: randomUUID(), status, updatedAt: "2026-09-16T00:00:00.000Z", message: "private historical input", targetSessionId: randomUUID() });

test("sealed exact snapshot survives restart without invented attempts or quality credit", async () => {
  const file = path(), records = [record(), record("cancelled"), record("undelivered")];
  let store = new TaskEvaluationStore(file);
  const migration = store.initializeLegacyTerminalSnapshot("journal-identity", records);
  expect(migration.snapshots).toBe(3);
  expect(store.claim(0, 10)).toBeUndefined();
  expect(store.legacyDispositions().every(r => r.disposition === "unverified")).toBe(true);
  expect(JSON.stringify(store.legacyDispositions())).not.toContain("private historical input");
  expect(await auditTerminalInstructions(store, records)).toEqual({ state: "complete" });
  store.close(); store = new TaskEvaluationStore(file);
  const newer = record();
  expect(store.initializeLegacyTerminalSnapshot("journal-identity", [...records, newer])).toEqual(migration);
  expect(await auditTerminalInstructions(store, [...records, newer])).toEqual({ state: "gap", reason: "canonical-instruction-projection-missing" });
  expect(await auditTerminalInstructions(store, [{ ...records[0]!, message: "changed without timestamp" }])).toEqual({ state: "gap", reason: "canonical-instruction-projection-missing" });
  expect(() => store.initializeLegacyTerminalSnapshot("replacement", records)).toThrow("SOURCE_CONFLICT");
  store.close();
});

test("interrupted snapshot transaction rolls back and cannot partially exempt history", async () => {
  const file = path(), one = record(); let store = new TaskEvaluationStore(file);
  function* interrupted() { yield one; throw new Error("crash before seal"); }
  expect(() => store.initializeLegacyTerminalSnapshot("journal", interrupted())).toThrow("crash before seal");
  expect(store.legacyMigration()).toBeUndefined(); expect(store.legacyDispositions()).toEqual([]);
  expect((await auditTerminalInstructions(store, [one])).state).toBe("gap");
  store.close(); store = new TaskEvaluationStore(file);
  store.initializeLegacyTerminalSnapshot("journal", [one]);
  expect((await auditTerminalInstructions(store, [one])).state).toBe("complete"); store.close();
});

test("empty snapshot seals future exemption; current capable and active records are not migrated", async () => {
  const store = new TaskEvaluationStore(path()), current = { ...record(), attemptGeneration: 1, terminalActivity: {} }, active = record("submitted");
  expect(store.initializeLegacyTerminalSnapshot("journal", [current, active, { ...record(), attemptGeneration: 1 },
    { ...record(), terminalActivity: {} }]).snapshots).toBe(0);
  expect((await auditTerminalInstructions(store, [current])).state).toBe("gap");
  expect(store.initializeLegacyTerminalSnapshot("journal", [record()]).snapshots).toBe(0);
  expect((await auditTerminalInstructions(store, [{ ...active, status: "completed" }])).state).toBe("gap"); store.close();
});

test("bounded snapshot and late initialization fail closed", () => {
  const store = new TaskEvaluationStore(path());
  expect(() => store.initializeLegacyTerminalSnapshot("journal", [record(), record()], 1)).toThrow("SNAPSHOT_LIMIT");
  expect(store.legacyMigration()).toBeUndefined(); expect(store.legacyDispositions()).toEqual([]);
  store.advanceCheckpoint("production", "activity", 0, 0);
  expect(() => store.initializeLegacyTerminalSnapshot("journal", [record()])).toThrow("INITIALIZATION_TOO_LATE"); store.close();
});

test("snapshot disk exhaustion retains no partial disposition and is restartable", () => {
  const file = path(); const store = new TaskEvaluationStore(file, 128 * 1024);
  function* records(): Generator<LegacyInstructionSnapshot> { for (let i = 0; i < 1000; i++) yield record(); }
  expect(() => store.initializeLegacyTerminalSnapshot("journal", records())).toThrow();
  expect(store.legacyMigration()).toBeUndefined(); expect(store.legacyDispositions()).toEqual([]); store.close();
  const recovered = new TaskEvaluationStore(file, 128 * 1024); expect(recovered.legacyMigration()).toBeUndefined(); recovered.close();
});
