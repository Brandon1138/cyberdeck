import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PersistedJobState } from "../../src/control-plane/job-control-plane.js";
import { JobStore } from "../../src/persistence/job-store.js";

const directories: string[] = [];
const NOW = "2026-07-21T10:00:00.000Z";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cyberdeck-job-store-"));
  directories.push(path);
  return path;
}

function state(overrides: Partial<PersistedJobState> = {}): PersistedJobState {
  const id = randomUUID();
  return {
    idempotencyKey: `key-${id}`,
    record: {
      schemaVersion: 1,
      id,
      correlationId: randomUUID(),
      request: {
        schemaVersion: 1,
        provider: "codex",
        cwd: "/tmp/repo",
        sandbox: "read-only",
        instruction: "bounded fixture work",
      },
      lifecycle: { status: "queued", enqueuedAt: NOW },
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  } as PersistedJobState;
}

describe("JobStore", () => {
  it("round-trips validated snapshots in append order and keeps the latest state", async () => {
    const store = new JobStore(await stateDirectory(), { now: () => NOW });
    const queued = state();
    const dispatched: PersistedJobState = {
      ...queued,
      record: {
        ...queued.record,
        lifecycle: { status: "dispatched", dispatchedAt: NOW },
      },
    };

    await store.append(queued);
    await store.append(dispatched);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.record.lifecycle.status).toBe("dispatched");
  });

  it("returns an empty history when the store does not exist", async () => {
    const store = new JobStore(await stateDirectory());
    await expect(store.load()).resolves.toEqual([]);
  });

  it("tolerates only an incomplete final JSONL record", async () => {
    const store = new JobStore(await stateDirectory());
    const valid = state();
    await store.append(valid);
    await appendFile(store.path, '{"schemaVersion":1,"recordType":"job.snapshot"', "utf8");

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.record.id).toBe(valid.record.id);
  });

  it("fails closed on a corrupt newline-terminated middle record", async () => {
    const store = new JobStore(await stateDirectory());
    await store.append(state());
    await appendFile(store.path, "not-json\n", "utf8");
    await store.append(state());

    await expect(store.load()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
  });

  it("rejects unsupported schema versions before replay", async () => {
    const store = new JobStore(await stateDirectory());
    await store.append(state());
    const text = await readFile(store.path, "utf8");
    await writeFile(store.path, text.replace('"schemaVersion":1', '"schemaVersion":2'), "utf8");

    await expect(store.load()).rejects.toMatchObject({ code: "SCHEMA_VERSION_UNSUPPORTED" });
  });

  it("fails closed on a duplicate persistence event id", async () => {
    const store = new JobStore(await stateDirectory());
    await store.append(state());
    const line = await readFile(store.path, "utf8");
    await appendFile(store.path, line, "utf8");

    await expect(store.load()).rejects.toMatchObject({ code: "DUPLICATE_EVENT_ID" });
  });

  it("strips unknown fields from a newer producer on the current schema", async () => {
    const store = new JobStore(await stateDirectory());
    await store.append(state());
    const line = JSON.parse((await readFile(store.path, "utf8")).trim()) as Record<string, unknown>;
    line.futureField = { safeToIgnore: true };
    await writeFile(store.path, `${JSON.stringify(line)}\n`, "utf8");

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect("futureField" in (loaded[0] ?? {})).toBe(false);
  });
});
