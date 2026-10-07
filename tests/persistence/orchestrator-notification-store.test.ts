import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as privateFiles from "../../src/persistence/private-files.js";
import {
  coalescedDedupeKey, DEFAULT_NOTIFICATION_POLICY, NOTIFICATION_LIMITS, settledDedupeKey,
  type NotificationKind,
} from "../../src/domain/orchestrator-notification.js";
import {
  OrchestratorNotificationStore, OrchestratorNotificationStoreError,
  type NewOrchestratorNotification,
} from "../../src/persistence/orchestrator-notification-store.js";

const NOW = "2026-10-07T10:00:00.000Z";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function store(): Promise<OrchestratorNotificationStore> {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-notifications-"));
  directories.push(directory);
  const result = new OrchestratorNotificationStore(directory, { now: () => NOW });
  await result.load();
  return result;
}
async function reload(original: OrchestratorNotificationStore): Promise<OrchestratorNotificationStore> {
  const result = new OrchestratorNotificationStore(dirname(dirname(original.path)), { now: () => NOW });
  await result.load();
  return result;
}
function input(overrides: Partial<NewOrchestratorNotification> = {}): NewOrchestratorNotification {
  return { controllerId: "orchestrator:a", sessionId: crypto.randomUUID(), kind: "progress",
    severity: "info", summary: "Working", wakeEligible: false, ...overrides };
}
async function lines(subject: OrchestratorNotificationStore): Promise<Record<string, any>[]> {
  return (await readFile(subject.path, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
}

describe("OrchestratorNotificationStore", () => {
  it("round trips append/list/acknowledge and replays a lost page until explicit acknowledgement", async () => {
    const subject = await store();
    const first = await subject.append(input({ createdAt: "2026-10-07T09:00:00.000Z" }));
    const second = await subject.append(input());
    expect(first).toMatchObject({ outcome: "appended", dropped: 0, record: { cursor: 1,
      createdAt: "2026-10-07T09:00:00.000Z", deliveredVia: [], refs: [], schemaVersion: 1 } });
    expect(second.record?.createdAt).toBe(NOW);
    const page = subject.listPending("orchestrator:a", 0, 1);
    expect(subject.listPending("orchestrator:a", 0, 1)).toEqual(page);
    expect((await reload(subject)).listPending("orchestrator:a", 0, 1)).toEqual(page);
    expect(await subject.acknowledgeThrough("orchestrator:a", 1)).toBe(1);
    expect(await subject.acknowledgeThrough("orchestrator:a", 1)).toBe(0);
    expect(subject.listPending("orchestrator:a", 0, 50).map((record) => record.cursor)).toEqual([2]);
    expect((await reload(subject)).listPending("orchestrator:a", 0, 50).map((record) => record.cursor)).toEqual([2]);
    expect(await subject.acknowledgeThrough("orchestrator:a", 2)).toBe(1);
    expect((await reload(subject)).pendingCount("orchestrator:a")).toBe(0);
    expect(subject.headCursor("orchestrator:a")).toBe(2);
    expect((await stat(subject.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(subject.path))).mode & 0o777).toBe(0o700);
  });

  it("serializes concurrent appends and gives each controller independent monotonic cursors", async () => {
    const subject = await store();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => subject.append(
      input({ controllerId: index % 2 === 0 ? "orchestrator:a" : "orchestrator:b" }),
    )));
    for (const controllerId of ["orchestrator:a", "orchestrator:b"]) {
      expect(results.filter((result) => result.record?.controllerId === controllerId).map((result) => result.record?.cursor))
        .toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
      expect(subject.pendingCount(controllerId)).toBe(10);
      expect(subject.headCursor(controllerId)).toBe(10);
    }
    const replay = await reload(subject);
    await replay.load();
    expect(replay.controllers()).toEqual(["orchestrator:a", "orchestrator:b"]);
    expect(replay.listPending("orchestrator:a", 0, 50)).toEqual(subject.listPending("orchestrator:a", 0, 50));
    expect(await replay.acknowledgeThrough("orchestrator:a", 10)).toBe(10);
    expect(replay.pendingCount("orchestrator:b")).toBe(10);
    expect((await replay.append(input())).record?.cursor).toBe(11);
  });

  it("clamps drain pages and filters by kind and severity without acknowledging", async () => {
    const subject = await store();
    await Promise.all(Array.from({ length: 60 }, (_, index) => subject.append(input({
      kind: index % 2 === 0 ? "risk" : "progress", severity: index % 3 === 0 ? "critical" : "info",
    }))));
    expect(subject.listPending("orchestrator:a", 0, 1000)).toHaveLength(NOTIFICATION_LIMITS.drainPageMax);
    expect(subject.listPending("orchestrator:a", 0, Infinity)).toHaveLength(50);
    expect(subject.listPending("orchestrator:a", 0, -1)).toEqual([]);
    expect(subject.listPending("orchestrator:a", 0, NaN)).toEqual([]);
    const filtered = subject.listPending("orchestrator:a", 5, 100, { kinds: ["risk"], severities: ["critical"] });
    expect(filtered.map((record) => record.cursor)).toEqual([7, 13, 19, 25, 31, 37, 43, 49, 55]);
    expect(subject.listPending("orchestrator:a", 0, 50, { kinds: [] })).toEqual([]);
    expect(subject.pendingCount("orchestrator:a")).toBe(60);
  });

  it("replaces ten progress notifications with one latest payload and a new drain cursor", async () => {
    const subject = await store();
    const sessionId = crypto.randomUUID();
    const dedupeKey = coalescedDedupeKey("progress", sessionId);
    for (let index = 1; index <= 10; index += 1) {
      const result = await subject.append(input({ sessionId, dedupeKey, summary: `progress ${index}` }), { dedupe: "replace" });
      expect(result).toMatchObject({ outcome: index === 1 ? "appended" : "replaced", dropped: 0,
        record: { cursor: index } });
    }
    expect(subject.pendingCount("orchestrator:a")).toBe(1);
    expect(subject.listPending("orchestrator:a", 9, 50)).toMatchObject([{ cursor: 10, summary: "progress 10" }]);
    const replay = await reload(subject);
    expect(replay.listPending("orchestrator:a", 0, 50)).toEqual(subject.listPending("orchestrator:a", 0, 50));
    await replay.acknowledgeThrough("orchestrator:a", 10);
    expect((await replay.append(input({ sessionId, dedupeKey }), { dedupe: "replace" })).outcome).toBe("appended");
  });

  it("preserves once-dedupe across pending replay, acknowledgement, eviction and controller boundaries", async () => {
    const subject = await store();
    const sessionId = crypto.randomUUID();
    const dedupeKey = settledDedupeKey(sessionId, 1);
    const settled = input({ sessionId, dedupeKey, kind: "settled", completionTarget: 1 });
    await subject.append(settled, { dedupe: "once" });
    const replay = await reload(subject);
    expect((await replay.append(settled, { dedupe: "once" })).outcome).toBe("duplicate");
    await replay.acknowledgeThrough("orchestrator:a", 1);
    expect((await replay.append(settled, { dedupe: "once" })).record?.acknowledgedAt).toBe(NOW);
    for (let index = 0; index < 101; index += 1) {
      const appended = await replay.append(input({ dedupeKey: `other:${index}` }));
      await replay.acknowledgeThrough("orchestrator:a", appended.record!.cursor);
    }
    const evicted = await reload(replay);
    expect(await evicted.append(settled, { dedupe: "once" })).toEqual({ outcome: "duplicate", dropped: 0 });
    expect(evicted.headCursor("orchestrator:a")).toBe(102);
    expect((await evicted.append({ ...settled, controllerId: "orchestrator:b" }, { dedupe: "once" })).outcome).toBe("appended");
  });

  it("drops by priority, oldest cursor within each class, counts drops durably and resets only sinceAcknowledged", async () => {
    const subject = await store();
    const kinds: NotificationKind[] = ["intervention", "delivery", "settled", "handoff", "attention", "risk", "budget", "progress", "progress"];
    const originals = [];
    for (const kind of kinds) originals.push((await subject.append(input({ kind }))).record!);
    for (let index = kinds.length; index < NOTIFICATION_LIMITS.maxUnacknowledgedPerController; index += 1) {
      await subject.append(input({ kind: "intervention" }));
    }
    const expected = [originals[7]!, originals[8]!, originals[6]!, originals[5]!, originals[4]!, originals[3]!, originals[2]!, originals[1]!, originals[0]!];
    for (const droppedRecord of expected) {
      expect((await subject.append(input({ kind: "intervention" }))).dropped).toBe(1);
      expect((await lines(subject)).at(-2)).toMatchObject({ recordType: "orchestrator-notification.drop",
        ids: [droppedRecord.id], reason: "capacity" });
    }
    expect(subject.pendingCount("orchestrator:a")).toBe(200);
    expect(subject.dropped("orchestrator:a")).toEqual({ total: 9, sinceAcknowledged: 9 });
    const replay = await reload(subject);
    expect(replay.dropped("orchestrator:a")).toEqual(subject.dropped("orchestrator:a"));
    expect(await replay.acknowledgeThrough("orchestrator:a", 0)).toBe(0);
    expect(replay.dropped("orchestrator:a")).toEqual({ total: 9, sinceAcknowledged: 0 });
    expect((await reload(replay)).dropped("orchestrator:a")).toEqual({ total: 9, sinceAcknowledged: 0 });
  });

  it("replaces at full capacity without drops; historical once keys survive capacity drops", async () => {
    const subject = await store();
    const keyed = input({ dedupeKey: "progress-key" });
    await subject.append(keyed, { dedupe: "replace" });
    for (let index = 1; index < 200; index += 1) await subject.append(input({ kind: "intervention" }));
    expect(await subject.append(keyed, { dedupe: "replace" })).toMatchObject({ outcome: "replaced", dropped: 0 });
    expect(subject.pendingCount("orchestrator:a")).toBe(200);
    await subject.append(input({ kind: "intervention" }));
    expect(await (await reload(subject)).append(keyed, { dedupe: "once" })).toMatchObject({ outcome: "duplicate", dropped: 0 });
  });

  it("persists policy, notice debounce and controllers with policy-only state", async () => {
    const subject = await store();
    expect(subject.controllers()).toEqual([]);
    expect(subject.policy("orchestrator:unknown")).toEqual(DEFAULT_NOTIFICATION_POLICY);
    expect(subject.noticeState("orchestrator:unknown")).toEqual({ lastNoticedCursor: 0, headCursor: 0 });
    expect(subject.controllers()).toEqual([]);
    const policy = { wake: "off" as const, quietMinutes: 20, maxWakesPerHour: 0, coalesceMs: 500 };
    expect(await subject.setPolicy("orchestrator:policy-only", policy)).toEqual(policy);
    await subject.append(input());
    await subject.markNoticed("orchestrator:a", 1);
    await subject.append(input());
    const replay = await reload(subject);
    expect(replay.policy("orchestrator:policy-only")).toEqual(policy);
    expect(replay.noticeState("orchestrator:a")).toEqual({ lastNoticedCursor: 1, lastNoticedAt: NOW, headCursor: 2 });
    expect(replay.controllers()).toEqual(["orchestrator:a", "orchestrator:policy-only"]);
    await expect(replay.markNoticed("orchestrator:a", 3)).rejects.toThrow("Notice cursor exceeds inbox head");
  });

  it("marks delivery without duplicates or acknowledgement; wait acknowledges only the matching key", async () => {
    const subject = await store();
    const first = (await subject.append(input({ dedupeKey: "first" }))).record!;
    const second = (await subject.append(input({ dedupeKey: "second", kind: "settled" }))).record!;
    await subject.markDelivered("orchestrator:a", [first.id, first.id, "unknown"], "hook");
    await subject.markDelivered("orchestrator:a", [first.id], "hook");
    await subject.markDelivered("orchestrator:b", [first.id], "tool-result");
    expect(subject.listPending("orchestrator:a", 0, 50)[0]).toMatchObject({ deliveredVia: ["hook"], noticedAt: NOW });
    expect(subject.pendingCount("orchestrator:a")).toBe(2);
    expect(await subject.acknowledgeByDedupeKey("orchestrator:a", "second", "wait"))
      .toMatchObject({ id: second.id, deliveredVia: ["wait"], noticedAt: NOW, acknowledgedAt: NOW });
    expect(await subject.acknowledgeByDedupeKey("orchestrator:a", "second", "wait")).toBeUndefined();
    expect((await reload(subject)).listPending("orchestrator:a", 0, 50).map((record) => record.id)).toEqual([first.id]);
  });

  it("keeps wait delivery pending until acknowledgement and supports selective consumption on every channel", async () => {
    const subject = await store();
    const oldest = (await subject.append(input({ dedupeKey: "oldest" }))).record!;
    for (const via of ["tool-result", "hook", "wake", "wait"] as const) {
      const key = `consume:${via}`;
      const added = (await subject.append(input({ dedupeKey: key }))).record!;
      await subject.markDelivered("orchestrator:a", [added.id], via);
      expect((await reload(subject)).pendingCount("orchestrator:a")).toBe(2);
      expect(await subject.acknowledgeByDedupeKey("orchestrator:b", key, via)).toBeUndefined();
      expect(await subject.acknowledgeByDedupeKey("orchestrator:a", key, via))
        .toMatchObject({ id: added.id, deliveredVia: [via], acknowledgedAt: NOW });
      expect((await reload(subject)).listPending("orchestrator:a", 0, 50).map((record) => record.id)).toEqual([oldest.id]);
    }
    expect(await subject.acknowledgeByDedupeKey("orchestrator:a", "missing", "wait")).toBeUndefined();
  });

  it("retries selective acknowledgement after a crash between delivered and acknowledged lines", async () => {
    const subject = await store();
    await subject.append(input({ dedupeKey: "oldest" }));
    const target = (await subject.append(input({ dedupeKey: "target" }))).record!;
    await subject.acknowledgeByDedupeKey("orchestrator:a", "target", "wait");
    const durable = (await readFile(subject.path, "utf8")).trimEnd().split("\n");
    expect(JSON.parse(durable.at(-1)!)).toMatchObject({
      recordType: "orchestrator-notification.acknowledge", throughCursor: 2, ids: [target.id],
    });
    await writeFile(subject.path, `${durable.slice(0, -1).join("\n")}\n`);
    const crashed = await reload(subject);
    expect(crashed.pendingCount("orchestrator:a")).toBe(2);
    expect(await crashed.acknowledgeByDedupeKey("orchestrator:a", "target", "wait"))
      .toMatchObject({ acknowledgedAt: NOW, deliveredVia: ["wait"] });
    expect((await reload(crashed)).pendingCount("orchestrator:a")).toBe(1);
  });

  it("returns defensive copies for payloads and policy", async () => {
    const subject = await store();
    const appended = await subject.append(input({ refs: ["original"] }));
    appended.record!.refs.push("mutated");
    const page = subject.listPending("orchestrator:a", 0, 50);
    page[0]!.deliveredVia.push("wait");
    page[0]!.summary = "mutated";
    subject.policy("orchestrator:a").wake = "off";
    expect(subject.listPending("orchestrator:a", 0, 50)[0]).toMatchObject({ refs: ["original"], deliveredVia: [], summary: "Working" });
    expect(subject.policy("orchestrator:a")).toEqual(DEFAULT_NOTIFICATION_POLICY);
  });

  it("does not write invalid inputs and continues after a rejected serialized mutation", async () => {
    const subject = await store();
    expect(() => subject.append(input({ summary: "x".repeat(513) }))).toThrow();
    await expect(subject.markNoticed("orchestrator:a", 2)).rejects.toThrow();
    expect((await subject.append(input())).record?.cursor).toBe(1);
    expect(await lines(subject)).toHaveLength(1);
  });

  it("requires replay after ambiguous fsync failure before assigning another cursor", async () => {
    const subject = await store();
    const originalOpen = privateFiles.openPrivateAppendFile;
    vi.spyOn(privateFiles, "openPrivateAppendFile").mockImplementationOnce(async (path) => {
      const handle = await originalOpen(path);
      vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("injected fsync failure"));
      return handle;
    });
    await expect(subject.append(input())).rejects.toThrow("injected fsync failure");
    expect(() => subject.pendingCount("orchestrator:a")).toThrow("load() must succeed first");
    await expect(subject.append(input())).rejects.toThrow("load() must succeed first");
    await subject.load();
    expect(subject.pendingCount("orchestrator:a")).toBe(1);
    expect((await subject.append(input())).record?.cursor).toBe(2);
    expect((await reload(subject)).pendingCount("orchestrator:a")).toBe(2);
  });
});

describe("notification replay faults", () => {
  for (const [name, tail, code] of [
    ["corrupt JSON", "{broken}\n", "STORE_CORRUPT"],
    ["blank line", " \n", "STORE_CORRUPT"],
    ["unsupported version", '{"schemaVersion":2}\n', "SCHEMA_VERSION_UNSUPPORTED"],
    ["bad envelope", '{"schemaVersion":1}\n', "STORE_CORRUPT"],
  ] as const) {
    it(`fails closed on ${name} with exact line`, async () => {
      const subject = await store();
      await subject.append(input());
      await appendFile(subject.path, tail);
      await expect(subject.load()).rejects.toMatchObject({ name: "OrchestratorNotificationStoreError", code, line: 2 });
      expect(() => subject.pendingCount("orchestrator:a")).toThrow("load() must succeed first");
    });
  }
  it("rejects duplicate record IDs and nested unsupported versions", async () => {
    const subject = await store();
    await subject.append(input());
    const original = await readFile(subject.path, "utf8");
    await appendFile(subject.path, original);
    await expect(reload(subject)).rejects.toEqual(expect.objectContaining<Partial<OrchestratorNotificationStoreError>>({
      code: "DUPLICATE_RECORD_ID", line: 2,
    }));
    const [record] = await lines(subject);
    record!.notification.schemaVersion = 2;
    await writeFile(subject.path, `${JSON.stringify(record)}\n`);
    await expect(reload(subject)).rejects.toMatchObject({ code: "SCHEMA_VERSION_UNSUPPORTED", line: 1 });
  });
  it("rejects cursor rollback and structurally valid replacements without pending predecessors", async () => {
    const subject = await store();
    await subject.append(input());
    const original = await readFile(subject.path, "utf8");
    const [first] = await lines(subject);
    first!.recordId = crypto.randomUUID();
    first!.notification.id = crypto.randomUUID();
    await writeFile(subject.path, original + `${JSON.stringify(first)}\n`);
    await expect(reload(subject)).rejects.toMatchObject({ code: "STORE_CORRUPT", line: 2 });
    first!.recordType = "orchestrator-notification.replace";
    first!.notification.cursor = 2;
    first!.replacesId = crypto.randomUUID();
    await writeFile(subject.path, original + `${JSON.stringify(first)}\n`);
    await expect(reload(subject)).rejects.toMatchObject({ code: "STORE_CORRUPT", line: 2 });
  });
  it("ignores only an unterminated crash fragment, then repairs it before appending", async () => {
    const subject = await store();
    await subject.append(input({ summary: "before crash" }));
    await appendFile(subject.path, '{"schemaVersion":1,"payload":"é');
    const recovered = await reload(subject);
    expect(recovered.pendingCount("orchestrator:a")).toBe(1);
    await recovered.append(input({ summary: "after crash" }));
    expect((await reload(recovered)).listPending("orchestrator:a", 0, 50).map((record) => record.summary))
      .toEqual(["before crash", "after crash"]);
    expect(await lines(recovered)).toHaveLength(2);
  });
});

describe("OrchestratorNotificationStore.onChange", () => {
  it("announces the controller after every fsynced mutation and isolates a throwing listener", async () => {
    const subject = await store();
    const seen: string[] = [];
    subject.onChange(() => { throw new Error("listener failed"); });
    const stop = subject.onChange((controllerId) => { seen.push(controllerId); });
    const appended = await subject.append(input({ controllerId: "orchestrator:fleet", kind: "settled", dedupeKey: "settled:x:1" }), { dedupe: "once" });
    expect(appended.outcome).toBe("appended");
    await subject.acknowledgeThrough("orchestrator:fleet", appended.record!.cursor);
    await subject.setPolicy("orchestrator:peer", { wake: "off", quietMinutes: 10, maxWakesPerHour: 12, coalesceMs: 3000 });
    expect(seen).toEqual(["orchestrator:fleet", "orchestrator:fleet", "orchestrator:peer"]);
    stop();
    await subject.markNoticed("orchestrator:fleet", appended.record!.cursor);
    expect(seen).toHaveLength(3);
  });
});
