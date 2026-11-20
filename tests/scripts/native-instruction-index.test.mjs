import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeInstructionIndex } from "../../dist/src/persistence/native-instruction-index.js";
import { InstructionStore } from "../../dist/src/persistence/instruction-store.js";

test("native index agrees with current journal semantics across lifecycle and failed validation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cyberdeck-native-index-"));
  const reference = new InstructionStore(dir);
  const path = reference.path,
    index = new NativeInstructionIndex(path);
  t.after(async () => {
    index.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await index.read("all"), []);
  await mkdir(join(dir, "orchestration"), { recursive: true });
  const at = "2026-11-19T00:00:00Z",
    actor = randomUUID(),
    target = randomUUID(),
    successor = randomUUID();
  const row = {
    id: randomUUID(),
    actorSessionId: actor,
    targetSessionId: target,
    message: " brief ",
    status: "queued",
    createdAt: at,
    updatedAt: at,
    messageId: randomUUID(),
    logicalRecipient: { kind: "resident", key: "resident:strigoi" },
  };
  const next = {
    ...row,
    continuations: [
      {
        instructionId: row.id,
        originalActorSessionId: actor,
        originalTargetSessionId: target,
        effectiveActorSessionId: successor,
        effectiveTargetSessionId: successor,
        transitionId: "transition",
        incarnation: 1,
        generation: 1,
        at,
      },
    ],
    submissionAttempt: {
      targetSessionId: successor,
      actorSessionId: actor,
      generation: 1,
      at,
      outcome: "unknown",
    },
    holdDetail: "detail",
    deliveryAttemptAt: at,
  };
  const other = {
    ...row,
    id: randomUUID(),
    status: "delivered",
    targetSessionId: successor,
    withdrawal: {
      kind: "operator",
      reason: "  test ",
      authority: { path: "/test", sha256: "0".repeat(64) },
      at,
    },
  };
  const line = (r) => JSON.stringify(r) + "\n";
  await writeFile(path, line(row) + line(other));
  assert.deepEqual(await index.read({ target: successor }), await reference.list(successor));
  const tail = line(next);
  await appendFile(path, tail.slice(0, 12));
  assert.deepEqual(await index.read("all"), await reference.list());
  await appendFile(path, tail.slice(12));
  for (const id of [successor, target, actor])
    assert.deepEqual(await index.read({ target: id }), await reference.list(id));
  assert.deepEqual(await index.read({ id: row.id }), [await reference.get(row.id)]);
  await appendFile(path, line({ ...other, status: "cancelled" }));
  assert.deepEqual(await index.read("unsettled"), await reference.listUnsettled());
  // Swap the effective target again. The original target is always still indexed.
  const moved = {
    ...next,
    continuations: [...next.continuations, { ...next.continuations[0], effectiveTargetSessionId: actor }],
  };
  await appendFile(path, line(moved));
  for (const id of [successor, target, actor])
    assert.deepEqual(await index.read({ target: id }), await reference.list(id));
  // Corruption in a superseded row must invalidate even a query for an unrelated id.
  await writeFile(path, line({ ...row, message: " other " }) + line(other) + line(next));
  assert.equal(await index.read({ id: other.id }), undefined);
  const old = process.env.CYBERDECK_INSTRUCTION_INDEX;
  process.env.CYBERDECK_INSTRUCTION_INDEX = "rust";
  const store = new InstructionStore(dir);
  if (old === undefined) delete process.env.CYBERDECK_INSTRUCTION_INDEX;
  else process.env.CYBERDECK_INSTRUCTION_INDEX = old;
  t.after(() => store.close());
  await assert.rejects(store.list(actor), /IMMUTABLE/);
  await writeFile(path + ".new", line(row));
  await rename(path + ".new", path);
  assert.deepEqual(await store.list(), await reference.list());
  const fresh = new NativeInstructionIndex(path);
  t.after(() => fresh.close());
  assert.deepEqual(await fresh.read("all"), await reference.list());
  await rm(path);
  assert.deepEqual(await fresh.read("all"), []);
  const interrupted = fresh.read("all");
  fresh.close();
  assert.equal(await interrupted, undefined);
});

test("a killed helper falls back on the same read and rebuilds after an intervening write", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cyberdeck-index-restart-"));
  const base = new InstructionStore(dir);
  const at = "2026-11-19T00:00:00Z";
  const record = {
    id: randomUUID(),
    actorSessionId: randomUUID(),
    targetSessionId: randomUUID(),
    messageId: randomUUID(),
    message: "durable",
    status: "queued",
    hop: 0,
    createdAt: at,
    updatedAt: at,
  };
  await base.put(record);
  const originalSpawn = childProcess.spawn;
  let starts = 0;
  t.mock.method(childProcess, "spawn", (...args) => {
    const child = originalSpawn(...args);
    if (String(args[0]).endsWith("/cyberdeck-index") && ++starts === 1) child.kill("SIGKILL");
    return child;
  });
  syncBuiltinESMExports();
  const old = process.env.CYBERDECK_INSTRUCTION_INDEX;
  process.env.CYBERDECK_INSTRUCTION_INDEX = "rust";
  const store = new InstructionStore(dir);
  if (old === undefined) delete process.env.CYBERDECK_INSTRUCTION_INDEX;
  else process.env.CYBERDECK_INSTRUCTION_INDEX = old;
  t.after(async () => {
    store.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await store.list(), [record]);
  assert.equal(starts, 1);
  await base.put({ ...record, status: "completed" });
  assert.equal((await store.get(record.id)).status, "completed");
  assert.equal(starts, 1);
  const later = Date.now() + 31_000;
  t.mock.method(Date, "now", () => later);
  assert.deepEqual(await store.listUnsettled(), []);
  assert.equal(starts, 2);
  assert.deepEqual(await store.list(), await base.list());
});
