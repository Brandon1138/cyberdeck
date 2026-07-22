import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grantAllows, type CapabilityGrant } from "../../src/domain/capability.js";
import { ThreadTranscriptStore } from "../../src/persistence/thread-transcript-store.js";

const SESSION_ONE = "11111111-1111-4111-8111-111111111111";
const SESSION_TWO = "22222222-2222-4222-8222-222222222222";

describe("ThreadTranscriptStore", () => {
  it("persists ordered thread events and reads global changes by cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-transcripts-"));
    let id = 0;
    const store = new ThreadTranscriptStore(root, {
      now: () => "2026-07-22T12:00:00.000Z",
      idFactory: () => `${String(++id).padStart(8, "0")}-0000-4000-8000-000000000000`,
    });
    await store.append({ sessionId: SESSION_ONE, kind: "prompt", source: "human", text: "inspect" });
    await store.append({ sessionId: SESSION_TWO, kind: "output", source: "provider", text: "done" });

    await expect(store.read(SESSION_ONE)).resolves.toMatchObject({
      events: [{ cursor: 1, text: "inspect" }],
      nextCursor: 1,
    });
    await expect(store.changes(1)).resolves.toMatchObject({
      events: [{ cursor: 2, sessionId: SESSION_TWO, text: "done" }],
      nextCursor: 2,
    });

    const reopened = new ThreadTranscriptStore(root);
    await expect(reopened.changes()).resolves.toMatchObject({
      events: [{ cursor: 1 }, { cursor: 2 }],
      nextCursor: 2,
    });
  });
});

describe("capability grants", () => {
  const workspaceGrant: CapabilityGrant = {
    subjectSessionId: SESSION_ONE,
    capabilities: ["thread.list", "thread.read", "thread.enqueue"],
    scope: { kind: "workspace", cwd: "/repo/one" },
  };

  it("keeps capability and scope independent", () => {
    expect(grantAllows(workspaceGrant, "thread.read", { cwd: "/repo/one" })).toBe(true);
    expect(grantAllows(workspaceGrant, "thread.read", { cwd: "/repo/two" })).toBe(false);
    expect(grantAllows(workspaceGrant, "worker.start", { cwd: "/repo/one" })).toBe(false);
  });
});

