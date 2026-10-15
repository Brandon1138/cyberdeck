import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorAttentionSchema } from "../../src/domain/orchestrator-attention.js";
import { OrchestratorAttentionStore } from "../../src/persistence/orchestrator-attention-store.js";
import { writeAtomicPrivateFile } from "../../src/persistence/atomic-private-file.js";
import { ACTOR, WORKER, attentionHarness, cleanupAttentionHarnesses } from "../support/attention-harness.js";

afterEach(cleanupAttentionHarnesses);

describe("atomic attention state", () => {
  it("round-trips one private file per controller, including explicit cancellation", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request());
    const path = f.store.path(armed.controllerId);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(f.store.directory)).mode & 0o777).toBe(0o700);
    const reopened = new OrchestratorAttentionStore(f.directory);
    expect(await reopened.get(armed.controllerId)).toEqual(armed);
    await f.attention.cancel({ actorSessionId: ACTOR, epoch: armed.epoch, reason: "Operator decision" });
    expect(await reopened.list()).toMatchObject([{ epoch: armed.epoch, status: "cancelled", cancelReason: "Operator decision" }]);
  });

  it("ignores a torn uncommitted replacement and preserves its evidence", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request());
    const temporary = `${f.store.path(armed.controllerId)}.${randomUUID()}.pending`;
    await writeFile(temporary, '{"schemaVersion":1,');
    expect(await new OrchestratorAttentionStore(f.directory).list()).toEqual([armed]);
    expect(await readFile(temporary, "utf8")).toBe('{"schemaVersion":1,');
  });

  it("refuses a torn committed record at startup and never substitutes an empty wait", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request()); f.attention.stop();
    const path = f.store.path(armed.controllerId); await writeFile(path, '{"schemaVersion":1,');
    const reopened = new OrchestratorAttentionStore(f.directory);
    await expect(reopened.get(armed.controllerId)).rejects.toMatchObject({ code: "ATTENTION_CORRUPT" });
    await expect(f.makeControl(reopened).attention.start()).rejects.toMatchObject({ code: "ATTENTION_CORRUPT" });
    expect(await readFile(path, "utf8")).toBe('{"schemaVersion":1,');
  });

  it("a failed pre-rename write leaves the old record available for safe retry", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request()); f.attention.stop();
    const store = new OrchestratorAttentionStore(f.directory, async () => { throw new Error("before rename"); });
    const control = f.makeControl(store).attention;
    await expect(control.cancel({ actorSessionId: ACTOR, epoch: armed.epoch })).rejects.toThrow("before rename");
    expect((await store.get(armed.controllerId))!.status).toBe("armed");
    expect((await f.store.get(armed.controllerId))!.status).toBe("armed");
  });

  it("an ambiguous post-rename failure rereads the committed tombstone before retry", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request()); f.attention.stop();
    const store = new OrchestratorAttentionStore(f.directory, async (path, body) => {
      await writeAtomicPrivateFile(path, body); throw new Error("directory sync outcome unknown");
    });
    const control = f.makeControl(store).attention;
    const request = { actorSessionId: ACTOR, epoch: armed.epoch };
    await expect(control.cancel(request)).rejects.toThrow("outcome unknown");
    expect((await store.get(armed.controllerId))!.status).toBe("cancelled");
    expect((await control.cancel(request)).status).toBe("cancelled");
  });

  it("an ambiguous arm failure keeps a stable epoch when the same mutation is retried", async () => {
    const f = await attentionHarness(); f.attention.stop(); let fail = true;
    const store = new OrchestratorAttentionStore(f.directory, async (path, body) => {
      await writeAtomicPrivateFile(path, body); if (fail) { fail = false; throw new Error("after rename"); }
    });
    const control = f.makeControl(store).attention; const request = f.request();
    await expect(control.arm(request)).rejects.toThrow("after rename");
    const durable = (await store.list())[0]!;
    const retry = await control.arm(request);
    expect(retry.epoch).toBe(durable.epoch);
  });

  it("banks decision, pending intent and distinct coverage atomically, then clears the intent on cancellation", async () => {
    const f = await attentionHarness(); await f.report("Outstanding"); const armed = await f.attention.arm(f.request());
    const messageId = randomUUID();
    await f.store.update(armed.controllerId, async (current) => ({ ...current!,
      decision: { snapshotId: current!.snapshotId, outcome: "WAKE", coverage: current!.coverage.captured, at: current!.updatedAt },
      pendingIntent: { epoch: current!.epoch, messageId, coverage: current!.coverage.captured, createdAt: current!.updatedAt },
      coverage: { ...current!.coverage, evaluated: current!.coverage.captured },
    }));
    const reopened = new OrchestratorAttentionStore(f.directory);
    expect(await reopened.get(armed.controllerId)).toMatchObject({ pendingIntent: { messageId }, decision: { outcome: "WAKE" },
      coverage: { evaluated: [{ sessionId: WORKER, eventOrdinal: 1 }], submitted: [], consumed: [] } });
    await f.attention.cancel({ actorSessionId: ACTOR, epoch: armed.epoch });
    expect((await reopened.get(armed.controllerId))!.pendingIntent).toBeUndefined();
  });

  it("rejects wrong controller identity, unsupported schemas and stale pending intent epochs", async () => {
    const f = await attentionHarness(); const armed = await f.attention.arm(f.request());
    await expect(f.store.update(armed.controllerId, async () => ({ ...armed, controllerId: "orchestrator:foreign" })))
      .rejects.toMatchObject({ code: "ATTENTION_CORRUPT" });
    expect(OrchestratorAttentionSchema.safeParse({ ...armed, schemaVersion: 2 }).success).toBe(false);
    expect(OrchestratorAttentionSchema.safeParse({ ...armed, coverage: { ...armed.coverage,
      consumed: [{ ...armed.coverage.captured[0]!, eventOrdinal: 99 }] } }).success).toBe(false);
    expect(OrchestratorAttentionSchema.safeParse({ ...armed,
      pendingIntent: { epoch: randomUUID(), messageId: randomUUID(), coverage: [], createdAt: armed.armedAt } }).success).toBe(false);
    expect((await f.store.get(armed.controllerId))!.epoch).toBe(armed.epoch);
  });
});
