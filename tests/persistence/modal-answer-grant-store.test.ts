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
  it("round-trips grant, status, revoke on the canonical root", async () => {
    const grants = await store();

    expect((await grants.status("/repo")).enabled).toBe(false);

    const granted = await grants.set("/repo", true);
    expect(granted).toEqual({
      root: "/canonical/repo",
      authority: "operator",
      grantedAt: "2026-09-07T10:00:00.000Z",
    });
    expect(await grants.status("/repo")).toMatchObject({
      root: "/canonical/repo",
      enabled: true,
    });
    expect(await grants.allowsRoot("/canonical/repo")).toBe(true);
    // `allowsRoot` takes an already-canonical root; nothing widens to parents or children.
    expect(await grants.allowsRoot("/canonical/repo/sub")).toBe(false);
    expect(await grants.allowsRoot("/canonical")).toBe(false);

    expect(await grants.set("/repo", false)).toBeUndefined();
    expect((await grants.status("/repo")).enabled).toBe(false);
    expect(await grants.allowsRoot("/canonical/repo")).toBe(false);
  });

  it("appends rather than rewrites, and replays the ledger to the same answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-modal-grants-replay-"));
    const options = {
      canonicalize: async (path: string) => path,
      now: () => "2026-09-07T10:00:00.000Z",
    };
    const grants = new ModalAnswerGrantStore(directory, options);
    await grants.set("/repo", true);
    await grants.set("/other", true);
    await grants.set("/repo", false);
    await grants.set("/repo", true);

    const lines = (await readFile(grants.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);

    const reopened = new ModalAnswerGrantStore(directory, options);
    expect((await reopened.list()).map((grant) => grant.root)).toEqual(["/other", "/repo"]);
  });

  it("is idempotent: re-granting an active root appends nothing", async () => {
    const grants = await store();
    await grants.set("/repo", true);
    await grants.set("/repo", true);
    const lines = (await readFile(grants.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
  });
});
