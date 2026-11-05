import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InstructionStore } from "../../src/persistence/instruction-store.js";
import { InstructionRecordSchema } from "../../src/domain/instruction.js";
import { nativeInstructionBinary, replayInstructionsNative } from "../../src/persistence/native-instruction-replay.js";
import { ValidatedJournal } from "../../src/persistence/validated-journal.js";

const available = existsSync(nativeInstructionBinary);
if (!available && process.env.CYBERDECK_REQUIRE_NATIVE_TESTS === "1") throw new Error("Run pnpm build:native before the required native tests");
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "cyberdeck-rust-core-")); dirs.push(path); return path; }
const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const base = { id, actorSessionId: id, targetSessionId: id, messageId: id, message: "fixture", status: "queued", createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z" };
async function stores(content: string | Buffer) {
  const dir = await directory();
  const ts = new InstructionStore(dir, { replay: "typescript" });
  const rust = new InstructionStore(dir, { replay: "rust" });
  await mkdir(join(dir, "orchestration"));
  await writeFile(ts.path, content);
  return { ts, rust };
}
const line = (value: unknown) => JSON.stringify(value) + "\n";

describe.skipIf(!available)("Rust instruction replay parity", () => {
  const cases: Record<string, unknown>[] = [
    {}, { status: "delivered" }, { message: "\ufeff  fixture \ufeff" }, { message: "\u0085" },
    { message: "emoji 🦀 / Ελληνικά / 日本語" }, { hop: 9007199254740991 }, { hop: -0 },
    { id: "00000000-0000-0000-0000-000000000000" }, { id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    { id: "ABCDEF12-1234-8123-ABCD-ABCDEFABCDEF" }, { status: "completed", completedAt: "2000-02-29T23:59:59.123456Z" },
    { createdAt: "0000-02-29T00:00:00Z" }, { createdAt: "2024-02-29T00:00:00Z" },
    { senderSessionId: id, renderedAt: base.createdAt, submittedAt: base.createdAt, expectedTurn: 1,
      holdReason: "", workflowRunId: id, causationId: other, brokerOwned: false, launch: true, submissionKind: "wake",
      wake: { controllerId: "fixture", cursor: 0, attentionEpoch: id, notificationIds: [other] } },
    { wake: { controllerId: "fixture", cursor: 1, notificationIds: [] } }, { unknown: { future: true } },
    ...["accepted", "queued", "rendered", "submitted", "acknowledged", "completed", "undelivered", "cancelled"].map((status) => ({ status })),
    { hop: -1 }, { hop: 0.5 }, { hop: 9007199254740992 }, { hop: null }, { hop: "0" },
    { expectedTurn: 0 }, { expectedTurn: -1 }, { expectedTurn: null }, { expectedTurn: 1.1 },
    { message: "\ufeff \t\n" }, { message: null }, { status: "submitted-ish" }, { status: "toString" },
    { id: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" }, { id: "11111111-1111-0111-8111-111111111111" },
    { id: "11111111-1111-4111-7111-111111111111" }, { senderSessionId: "invalid" },
    { createdAt: "1900-02-29T00:00:00Z" }, { createdAt: "2026-11-05T00:00Z" },
    { createdAt: "2026-11-05T00:00:60Z" }, { createdAt: "2026-11-05T24:00:00Z" },
    { createdAt: "2026-11-05T00:00:00+00:00" }, { createdAt: "2026-11-05t00:00:00z" },
    { createdAt: "2026-11-05T00:00:00.Z" }, { createdAt: "2026-02-30T00:00:00Z" },
    { renderedAt: null }, { brokerOwned: "false" }, { submissionKind: "ordinary" }, { wake: null },
    { wake: { controllerId: "", cursor: 1, notificationIds: [] } },
    { wake: { controllerId: "fixture", cursor: 0, notificationIds: [] } },
    { wake: { controllerId: "fixture", cursor: 1, notificationIds: ["invalid"] } },
    { wake: { controllerId: "fixture", cursor: 1, notificationIds: [], attentionEpoch: null } },
  ];
  it.each(cases.map((value, index) => [index, value] as const))("matches schema case %i", async (_index, patch) => {
    const record = { ...base, ...patch };
    const { ts, rust } = await stores(line(record));
    if (InstructionRecordSchema.safeParse(record).success) expect(await rust.list()).toEqual(await ts.list());
    else { await expect(ts.list()).rejects.toThrow(); await expect(rust.list()).rejects.toThrow(); }
  });

  it("preserves ordering, default hop, duplicate keys and torn final lines", async () => {
    const first = line(base).replace('"queued"', '"accepted","status":"delivered"');
    const { ts, rust } = await stores("\ufeff\n" + first + line({ ...base, id: other }) + line({ ...base, status: "completed" }) + '{"partial":');
    expect(await rust.list()).toEqual(await ts.list());
    expect((await rust.list()).map((r) => r.id)).toEqual([id, other]);
  });
  it.each(["{broken}\n", line({ ...base, message: "" })])("rejects invalid superseded history", async (bad) => {
    const { ts, rust } = await stores(bad + line(base));
    await expect(ts.list()).rejects.toThrow(); await expect(rust.list()).rejects.toThrow();
    await expect(rust.list()).rejects.toThrow();
  });
  it("invalidates cached native projections and isolates caller mutation", async () => {
    const { rust } = await stores(line(base));
    (await rust.list())[0]!.message = "caller mutation";
    expect((await rust.list())[0]!.message).toBe("fixture");
    await writeFile(rust.path, line({ ...base, message: "changed" }));
    expect((await rust.list())[0]!.message).toBe("changed");
    await writeFile(rust.path + ".new", line({ ...base, message: "replace" }));
    await rename(rust.path + ".new", rust.path);
    expect((await rust.list())[0]!.message).toBe("replace");
    await rust.put(InstructionRecordSchema.parse({ ...base, id: other }));
    expect(await rust.list()).toHaveLength(2);
    expect(await rust.list(other)).toEqual([]);
    await appendFile(rust.path, "{bad}\n");
    await expect(rust.list()).rejects.toThrow();
    await writeFile(rust.path, ""); expect(await rust.list()).toEqual([]);
    await rm(rust.path); expect(await rust.list()).toEqual([]);
  });
  it("fails closed for strict UTF-8 and lone surrogate input", async () => {
    const { rust } = await stores(Buffer.concat([Buffer.from(line(base).replace("fixture", "MARK").split("MARK")[0]!), Buffer.from([0xff]), Buffer.from(line(base).split("fixture")[1]!)]));
    await expect(rust.list()).rejects.toThrow();
    await writeFile(rust.path, line({ ...base, message: "\ud800" }));
    await expect(rust.list()).rejects.toThrow();
  });
  it("rejects oversized input records", async () => {
    const { rust } = await stores(line({ ...base, message: "x".repeat(16 * 1024 * 1024) }));
    await expect(rust.list()).rejects.toThrow();
  });
  it("reports the failing historical line without journal content", async () => {
    const { rust } = await stores(line(base) + '{private-fixture-payload}\n');
    await expect(rust.list()).rejects.toThrow("INVALID_JSON at line 2");
    await expect(rust.list()).rejects.not.toThrow("private-fixture-payload");
  });
});

describe("native worker failure boundary", () => {
  // Fixture children use the running Node binary, never a provider or broker.
  async function worker(source: string) {
    const dir = await directory();
    const script = join(dir, "worker.mjs"), binary = join(dir, "worker");
    await writeFile(script, source);
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)}\n`);
    await chmod(binary, 0o755);
    const file = await open(join(dir, "journal"), "w+");
    await file.writeFile(line(base));
    return { binary, file };
  }
  const complete = '{"protocol":1,"schema":"instruction-v1"}\n{"end":true,"records":0}\n';
  it.each([
    ["wrong version", '{"protocol":2}\n', 0],
    ["partial footer", '{"protocol":1,"schema":"instruction-v1"}\n', 0],
    ["nonzero after complete output", complete, 1],
    ["trailing output", complete + '{}\n', 0],
    ["count mismatch", complete.replace('"records":0', '"records":1'), 0],
    ["missing final newline", complete.trimEnd(), 0],
    ["invalid retained record", complete.replace('{"end"', '{}\n{"end"'), 0],
  ] as const)("rejects %s", async (_name, output, code) => {
    const { binary, file } = await worker(`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(output)}, () => process.exit(${code})); });`);
    try { await expect(replayInstructionsNative(file, { binary })).rejects.toThrow(); }
    finally { await file.close(); }
  });
  it("kills and reaps timed out workers", async () => {
    const { binary, file } = await worker("process.stdin.resume(); setInterval(() => {}, 1000);");
    try { await expect(replayInstructionsNative(file, { binary, timeoutMs: 100 })).rejects.toThrow("timed out"); }
    finally { await file.close(); }
  });
  it("rejects output over budget", async () => {
    const { binary, file } = await worker(`process.stdin.resume(); process.stdout.write(${JSON.stringify(complete)});`);
    try { await expect(replayInstructionsNative(file, { binary, maxOutputBytes: 8 })).rejects.toThrow("output limit"); }
    finally { await file.close(); }
  });
  it("fails explicitly when the selected binary is missing", async () => {
    const { file } = await worker("");
    try { await expect(replayInstructionsNative(file, { binary: "/nonexistent/cyberdeck-core" })).rejects.toThrow(); }
    finally { await file.close(); }
  });
  it("revalidates descriptor and path identity after an asynchronous projection", async () => {
    const dir = await directory(), path = join(dir, "journal");
    await writeFile(path, "old");
    let calls = 0;
    const journal = new ValidatedJournal(path, (text) => text, async (file) => {
      const value = await file.readFile("utf8");
      if (++calls === 1) { await writeFile(path + ".new", "new"); await rename(path + ".new", path); }
      return value;
    });
    expect(await journal.read()).toBe("new"); expect(calls).toBe(2);
  });
});
