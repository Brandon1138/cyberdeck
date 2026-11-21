import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModalAnswerGrantStore } from "../../src/persistence/modal-answer-grant-store.js";

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-modal-grants-"));
  return new ModalAnswerGrantStore(directory, {
    canonicalize: async (path) => `/canonical${path}`,
    now: () => "2026-09-07T10:00:00.000Z",
  });
}

describe("ModalAnswerGrantStore", () => {
  it("is on by default for every root, with no record written", async () => {
    const grants = await store();

    expect(await grants.status("/repo")).toEqual({ root: "/canonical/repo", enabled: true });
    expect(await grants.allowsRoot("/canonical/repo")).toBe(true);
    expect(await grants.allowsRoot("/canonical/anything-else")).toBe(true);
    expect(await grants.list()).toEqual([]);
    expect(await grants.revoked()).toEqual([]);

    // Turning a root on that was never switched off appends nothing and returns no grant record.
    expect(await grants.set("/repo", true)).toBeUndefined();
    await expect(readFile(grants.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips off, status, on again on the canonical root", async () => {
    const grants = await store();

    expect(await grants.set("/repo", false)).toBeUndefined();
    expect(await grants.status("/repo")).toEqual({ root: "/canonical/repo", enabled: false });
    expect(await grants.allowsRoot("/canonical/repo")).toBe(false);
    expect(await grants.revoked()).toEqual(["/canonical/repo"]);
    // An opt-out names exactly one root; parents and children stay on like any other root.
    expect(await grants.allowsRoot("/canonical/repo/sub")).toBe(true);
    expect(await grants.allowsRoot("/canonical")).toBe(true);

    const granted = await grants.set("/repo", true);
    expect(granted).toEqual({
      root: "/canonical/repo",
      authority: "operator",
      grantedAt: "2026-09-07T10:00:00.000Z",
    });
    expect(await grants.status("/repo")).toMatchObject({
      root: "/canonical/repo",
      enabled: true,
      grant: { root: "/canonical/repo", authority: "operator" },
    });
    expect(await grants.allowsRoot("/canonical/repo")).toBe(true);
    expect(await grants.revoked()).toEqual([]);
  });

  it("appends rather than rewrites, and replays the ledger to the same answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-modal-grants-replay-"));
    const options = {
      canonicalize: async (path: string) => path,
      now: () => "2026-09-07T10:00:00.000Z",
    };
    const grants = new ModalAnswerGrantStore(directory, options);
    await grants.set("/repo", false);
    await grants.set("/other", false);
    await grants.set("/repo", true);
    await grants.set("/repo", false);

    const lines = (await readFile(grants.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);

    const reopened = new ModalAnswerGrantStore(directory, options);
    expect(await reopened.revoked()).toEqual(["/other", "/repo"]);
    expect(await reopened.list()).toEqual([]);
    expect(await reopened.allowsRoot("/repo")).toBe(false);
    expect(await reopened.allowsRoot("/third")).toBe(true);
  });

  it("is idempotent: switching an already-off root off again appends nothing", async () => {
    const grants = await store();
    await grants.set("/repo", false);
    await grants.set("/repo", false);
    const lines = (await readFile(grants.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
