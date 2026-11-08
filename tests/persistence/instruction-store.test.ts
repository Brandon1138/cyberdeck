import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { InstructionRecordSchema, type InstructionRecord } from "../../src/domain/instruction.js";
import { InstructionStore } from "../../src/persistence/instruction-store.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-instructions-"));
  directories.push(root);
  const record: InstructionRecord = {
    id: randomUUID(), actorSessionId: randomUUID(), targetSessionId: randomUUID(),
    messageId: randomUUID(), message: "brief", status: "queued", hop: 0,
    createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z",
  };
  const store = new InstructionStore(root);
  await store.put(record);
  return { root, store, record };
}

it("validates unchanged instructions once across controller recovery reads", async () => {
  const { store, record } = await setup();
  const parse = vi.spyOn(InstructionRecordSchema, "parse");
  for (let controller = 0; controller < 100; controller++) {
    expect(await store.list(controller % 2 ? record.targetSessionId : undefined)).toEqual([record]);
  }
  expect(parse).toHaveBeenCalledTimes(1);
});

it("isolates caller mutations and observes local writes, external writes, replacement and deletion", async () => {
  const { root, store, record } = await setup();
  (await store.list())[0]!.status = "completed";
  expect((await store.list())[0]!.status).toBe("queued");
  await store.put({ ...record, status: "submitted" });
  expect((await store.list())[0]!.status).toBe("submitted");
  await new InstructionStore(root).put({ ...record, status: "completed" });
  expect((await store.list())[0]!.status).toBe("completed");
  const replacement = JSON.stringify({ ...record, message: "other" }) + "\n";
  await writeFile(`${store.path}.new`, replacement);
  await rename(`${store.path}.new`, store.path);
  expect((await store.list())[0]!.message).toBe("other");
  await writeFile(store.path, replacement.replace("other", "newer"));
  expect((await store.list())[0]!.message).toBe("newer");
  await rm(store.path);
  expect(await store.list()).toEqual([]);
});

it("ignores a torn tail but never serves cached instructions over corrupt committed state", async () => {
  const { store, record } = await setup();
  await store.list();
  await appendFile(store.path, '{"id":');
  expect(await store.list()).toEqual([record]);
  await appendFile(store.path, "broken}\n");
  await expect(store.list()).rejects.toThrow();
  await expect(store.list()).rejects.toThrow();
});
