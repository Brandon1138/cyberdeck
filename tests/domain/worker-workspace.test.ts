import { describe, expect, it } from "vitest";
import {
  WorkerWorkspaceSchema,
  checkWorkerWorkspaceShape,
  validateWorkerWorkspace,
  workspaceWritableRoots,
  type WorkerWorkspace,
  type WorkspaceProbe,
} from "../../src/domain/worker-workspace.js";

const workspace: WorkerWorkspace = {
  worktreePath: "/repo/worktrees/mik-70",
  branch: "brandon/mik-70",
  baseRef: "main",
  provisioning: "pre-provisioned",
  writableRoots: [],
};

/** A repository whose answers are stated rather than executed. */
function probeFor(answers: {
  gitCommonDirectory?: string | undefined;
  worktreeRoot?: string | undefined;
  checkedOutBranch?: string | undefined;
  refs?: string[];
}): WorkspaceProbe {
  return {
    gitCommonDirectory: async () => answers.gitCommonDirectory,
    worktreeRoot: async () => answers.worktreeRoot,
    checkedOutBranch: async () => answers.checkedOutBranch,
    refResolves: async (_path, ref) => (answers.refs ?? ["main"]).includes(ref),
  };
}

describe("WorkerWorkspaceSchema", () => {
  it("accepts a fully declared workspace and defaults writable roots to none", () => {
    const parsed = WorkerWorkspaceSchema.parse({
      worktreePath: "/repo/worktrees/mik-70",
      branch: "brandon/mik-70",
      baseRef: "main",
      provisioning: "pre-provisioned",
    });
    expect(parsed.writableRoots).toEqual([]);
  });

  it.each([
    { field: "worktreePath", value: "worktrees/mik-70" },
    { field: "writableRoots", value: ["relative/path"] },
  ])("refuses a relative $field", ({ field, value }) => {
    expect(() => WorkerWorkspaceSchema.parse({ ...workspace, [field]: value })).toThrow();
  });

  it.each(["--upload-pack=evil", "feature branch", "refs/heads/../../etc", "release~1", "wip*"])(
    "refuses ref %s, which git would read as a flag or a pattern",
    (branch) => {
      expect(() => WorkerWorkspaceSchema.parse({ ...workspace, branch })).toThrow();
    },
  );

  it("refuses fields nobody declared, so a typo is not silently dropped", () => {
    expect(() => WorkerWorkspaceSchema.parse({ ...workspace, worktree: "/repo" })).toThrow();
  });
});

describe("checkWorkerWorkspaceShape", () => {
  it("accepts a pre-provisioned cwd at or below the declared worktree", () => {
    expect(checkWorkerWorkspaceShape(workspace, workspace.worktreePath).ok).toBe(true);
    expect(checkWorkerWorkspaceShape(workspace, "/repo/worktrees/mik-70/src").ok).toBe(true);
  });

  it("rejects a pre-provisioned cwd outside the declared worktree", () => {
    const check = checkWorkerWorkspaceShape(workspace, "/repo/worktrees/mik-71");
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_CWD_OUTSIDE_WORKTREE");
  });

  it("does not accept a sibling whose path merely shares a prefix", () => {
    const check = checkWorkerWorkspaceShape(workspace, "/repo/worktrees/mik-700");
    expect(check.ok).toBe(false);
  });

  it("expects a worker-provisioned cwd to be the repository, not the worktree it will create", () => {
    const workerProvisioned = { ...workspace, provisioning: "worker-provisioned" as const };
    expect(checkWorkerWorkspaceShape(workerProvisioned, "/repo").ok).toBe(true);
    const check = checkWorkerWorkspaceShape(workerProvisioned, workspace.worktreePath);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_CWD_OUTSIDE_WORKTREE");
    expect(check.message).toContain("supposed to create");
  });
});

describe("validateWorkerWorkspace, pre-provisioned", () => {
  const probe = probeFor({
    worktreeRoot: "/repo/worktrees/mik-70",
    checkedOutBranch: "brandon/mik-70",
    refs: ["main"],
  });

  it("accepts a worktree that is there, on the declared branch, with a resolvable base", async () => {
    const check = await validateWorkerWorkspace({
      workspace,
      cwd: workspace.worktreePath,
      sandbox: "workspace-write",
      probe,
    });
    expect(check.ok).toBe(true);
  });

  it("does not require write access, because nothing has to be created", async () => {
    const check = await validateWorkerWorkspace({
      workspace,
      cwd: workspace.worktreePath,
      sandbox: "read-only",
      probe,
    });
    expect(check.ok).toBe(true);
  });

  it("reports a worktree nothing provisioned", async () => {
    const check = await validateWorkerWorkspace({
      workspace,
      cwd: workspace.worktreePath,
      sandbox: "workspace-write",
      probe: probeFor({ worktreeRoot: undefined }),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_WORKTREE_MISSING");
  });

  it("reports a path that is inside some other worktree rather than being one", async () => {
    const check = await validateWorkerWorkspace({
      workspace,
      cwd: workspace.worktreePath,
      sandbox: "workspace-write",
      probe: probeFor({ worktreeRoot: "/repo", checkedOutBranch: "brandon/mik-70" }),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_WORKTREE_MISSING");
    expect(check.message).toContain("/repo");
  });

  it("reports the branch actually checked out when it is not the declared one", async () => {
    const check = await validateWorkerWorkspace({
      workspace,
      cwd: workspace.worktreePath,
      sandbox: "workspace-write",
      probe: probeFor({
        worktreeRoot: "/repo/worktrees/mik-70",
        checkedOutBranch: "brandon/mik-64",
      }),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_BRANCH_MISMATCH");
    expect(check.message).toContain("brandon/mik-64");
  });

  it("names a detached HEAD rather than reporting a missing branch", async () => {
    const check = await validateWorkerWorkspace({
      workspace,
      cwd: workspace.worktreePath,
      sandbox: "workspace-write",
      probe: probeFor({ worktreeRoot: "/repo/worktrees/mik-70", checkedOutBranch: undefined }),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_BRANCH_MISMATCH");
    expect(check.message).toContain("detached HEAD");
  });

  it("reports a base ref that does not resolve, so no review has a baseline", async () => {
    const check = await validateWorkerWorkspace({
      workspace: { ...workspace, baseRef: "origin/gone" },
      cwd: workspace.worktreePath,
      sandbox: "workspace-write",
      probe,
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_BASE_REF_UNRESOLVED");
  });
});

describe("validateWorkerWorkspace, worker-provisioned", () => {
  // The 2026-08-14 failure verbatim: a worker told to run `git worktree add`, granted write access
  // to the worktree that did not exist yet and to nothing else, then denied by the sandbox with
  // `cannot lock ref ... 'Operation not permitted'` because the ref lives in the source repository.
  const workerProvisioned: WorkerWorkspace = {
    ...workspace,
    provisioning: "worker-provisioned",
  };
  const probe = probeFor({ gitCommonDirectory: "/repo/.git", refs: ["main"] });

  it("refuses a read-only sandbox, which cannot run git worktree add at all", async () => {
    const check = await validateWorkerWorkspace({
      workspace: workerProvisioned,
      cwd: "/repo",
      sandbox: "read-only",
      probe,
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_PROVISIONING_REQUIRES_WRITE");
  });

  it("refuses a workspace whose writable roots do not cover the git common directory", async () => {
    // The denial as it was actually observed: the worktree is under cwd and writable, the git
    // common directory the ref is created in is not.
    const check = await validateWorkerWorkspace({
      workspace: workerProvisioned,
      cwd: "/repo",
      sandbox: "workspace-write",
      probe: probeFor({ gitCommonDirectory: "/elsewhere/repo.git", refs: ["main"] }),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_GIT_DIR_NOT_WRITABLE");
    expect(check.message).toContain("/elsewhere/repo.git");
    expect(check.message).toContain(`refs/heads/${workerProvisioned.branch}`);
  });

  it("refuses a workspace that cannot create the worktree directory itself", async () => {
    const check = await validateWorkerWorkspace({
      workspace: { ...workerProvisioned, worktreePath: "/elsewhere/mik-70" },
      cwd: "/repo",
      sandbox: "workspace-write",
      probe,
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_TARGET_NOT_WRITABLE");
    expect(check.message).toContain("/elsewhere/mik-70");
  });

  it("accepts a workspace that granted the git common directory explicitly", async () => {
    const check = await validateWorkerWorkspace({
      workspace: {
        ...workerProvisioned,
        worktreePath: "/elsewhere/mik-70",
        writableRoots: ["/repo/.git", "/elsewhere"],
      },
      cwd: "/repo/checkout",
      sandbox: "workspace-write",
      probe,
    });
    expect(check.ok).toBe(true);
  });

  it("accepts a git common directory that already sits inside the worker's cwd", async () => {
    const check = await validateWorkerWorkspace({
      workspace: workerProvisioned,
      cwd: "/repo",
      sandbox: "workspace-write",
      probe,
    });
    expect(check.ok).toBe(true);
  });

  it("reports a cwd that is not a repository at all", async () => {
    const check = await validateWorkerWorkspace({
      workspace: { ...workerProvisioned, worktreePath: "/scratch/mik-70" },
      cwd: "/scratch",
      sandbox: "workspace-write",
      probe: probeFor({ gitCommonDirectory: undefined }),
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_WORKTREE_MISSING");
  });

  it("reports a base ref the new branch cannot be cut from", async () => {
    const check = await validateWorkerWorkspace({
      workspace: { ...workerProvisioned, baseRef: "origin/gone" },
      cwd: "/repo",
      sandbox: "workspace-write",
      probe,
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_BASE_REF_UNRESOLVED");
  });

  it("catches the contradiction without a probe, because that failure needs no repository", async () => {
    const check = await validateWorkerWorkspace({
      workspace: workerProvisioned,
      cwd: "/repo",
      sandbox: "read-only",
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("WORKSPACE_PROVISIONING_REQUIRES_WRITE");
  });
});

describe("workspaceWritableRoots", () => {
  it("grants nothing when no workspace was declared", () => {
    expect(workspaceWritableRoots(undefined)).toEqual([]);
  });

  it("normalizes, deduplicates, and drops the worktree a pre-provisioned worker runs in", () => {
    expect(workspaceWritableRoots({
      ...workspace,
      writableRoots: [
        "/repo/.git",
        "/repo/./.git",
        "/repo/worktrees/mik-70",
        "/var/tmp/reports",
      ],
    })).toEqual(["/repo/.git", "/var/tmp/reports"]);
  });

  it("keeps the target root of a worker-provisioned workspace", () => {
    // A worker-provisioned worker launches in the source repository, so its cwd does not cover the
    // worktree it has yet to create. Dropping the declared target here is what left `git worktree
    // add` without a grant for the directory the dispatch named.
    expect(workspaceWritableRoots({
      ...workspace,
      provisioning: "worker-provisioned",
      writableRoots: [
        "/repo/.git",
        "/repo/worktrees/mik-70",
        "/repo/worktrees/./mik-70",
      ],
    })).toEqual(["/repo/.git", "/repo/worktrees/mik-70"]);
  });
});
