import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeLeaseManager } from "../../src/control-plane/worktree-lease-manager.js";
import { LeaseStore } from "../../src/persistence/lease-store.js";

const directories: string[] = [];
const JOB_A = "11111111-1111-4111-8111-111111111111";
const JOB_B = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-leases-"));
  directories.push(root);
  const repo = join(root, "repo");
  const worktree = join(repo, "worktree");
  await mkdir(worktree, { recursive: true });
  return { root, repo, worktree, store: new LeaseStore(root) };
}

function clock(initial = Date.parse("2026-07-21T12:00:00.000Z")) {
  let value = initial;
  return { now: () => new Date(value).toISOString(), advance: (ms: number) => { value += ms; } };
}

describe("WorktreeLeaseManager", () => {
  it("canonicalizes path and symlink aliases into one conflicting write identity", async () => {
    const { root, repo, worktree, store } = await fixture();
    const alias = join(root, "alias");
    await symlink(worktree, alias);
    const manager = new WorktreeLeaseManager({ store });
    const lease = await manager.acquire({ repositoryPath: `${repo}/.`, worktreePath: `${worktree}/..//worktree`, access: "workspace-write", holderJobId: JOB_A });
    await expect(manager.acquire({ repositoryPath: repo, worktreePath: alias, access: "workspace-write", holderJobId: JOB_B })).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    expect(lease.canonicalKey).toContain("\0");
  });

  it("serializes simultaneous writers so exactly one acquires", async () => {
    const { repo, worktree, store } = await fixture();
    const manager = new WorktreeLeaseManager({ store });
    const results = await Promise.allSettled([
      manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_A }),
      manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_B }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("shares read-only leases but keeps workspace-write exclusive", async () => {
    const { repo, worktree, store } = await fixture();
    const manager = new WorktreeLeaseManager({ store });
    await manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "read-only", holderJobId: JOB_A });
    await expect(manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "read-only", holderJobId: JOB_B })).resolves.toBeDefined();
    await expect(manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: crypto.randomUUID() })).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
  });

  it("renews, expires, fences a replaced owner, rejects stale release, and releases idempotently", async () => {
    const { repo, worktree, store } = await fixture();
    const time = clock();
    const manager = new WorktreeLeaseManager({ store, now: time.now, defaultTtlMs: 100 });
    const first = await manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_A });
    time.advance(50);
    const renewed = await manager.renew(first);
    expect(Date.parse(renewed.lease.expiresAt!)).toBe(Date.parse(time.now()) + 100);
    time.advance(101);
    expect(await manager.validate(first)).toBe(false);
    const second = await manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_B });
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(await manager.validate(first)).toBe(false);
    await expect(manager.release(first)).rejects.toMatchObject({ code: "STALE_LEASE" });
    const released = await manager.release(second);
    await expect(manager.release(second)).resolves.toEqual(released);
  });

  it("recovers held leases as durable orphans and requires explicit manual resolution", async () => {
    const { repo, worktree, store } = await fixture();
    const first = new WorktreeLeaseManager({ store });
    const acquired = await first.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_A });
    const restarted = new WorktreeLeaseManager({ store });
    const orphans = await restarted.recover();
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ leaseId: acquired.lease.leaseId, manualRemediationRequired: true });
    expect(await restarted.validate(acquired)).toBe(false);
    await expect(restarted.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_B })).rejects.toMatchObject({ code: "LEASE_ORPHANED" });
    await restarted.resolveOrphan(acquired, { operatorConfirmed: true });
    await expect(restarted.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_B })).resolves.toBeDefined();
  });

  it("fails closed on corrupt persistence and refuses dirty-worktree cleanup", async () => {
    const { root, repo, worktree, store } = await fixture();
    await mkdir(join(root, "control-plane"), { recursive: true });
    await writeFile(store.path, "not-json\n", "utf8");
    await expect(new WorktreeLeaseManager({ store }).recover()).rejects.toMatchObject({ code: "STORE_CORRUPT" });

    const cleanStore = new LeaseStore(join(root, "clean-state"));
    const manager = new WorktreeLeaseManager({
      store: cleanStore,
      repositoryInspector: { canonicalize: async (path) => path, isWorktreeDirty: async () => true },
    });
    const held = await manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_A });
    const restarted = new WorktreeLeaseManager({ store: cleanStore, repositoryInspector: { canonicalize: async (path) => path, isWorktreeDirty: async () => true } });
    await restarted.recover();
    await expect(restarted.assessOrphanCleanup(held)).resolves.toMatchObject({ safeToDelete: false, dirty: true });
  });

  it("supports owner and job lookup", async () => {
    const { repo, worktree, store } = await fixture();
    const manager = new WorktreeLeaseManager({ store });
    const held = await manager.acquire({ repositoryPath: repo, worktreePath: worktree, access: "workspace-write", holderJobId: JOB_A });
    expect(manager.findByJob(JOB_A)).toEqual([held]);
    expect(manager.findByOwner(`job:${JOB_A}`)).toEqual([held]);
  });
});
