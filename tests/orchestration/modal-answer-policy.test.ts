import { describe, expect, it } from "vitest";
import { ModalAnswerPolicy } from "../../src/orchestration/modal-answer-policy.js";

function policy(options: {
  grantedRoots?: string[];
  commonDir?: Record<string, string>;
  primaryWorktree?: Record<string, string>;
} = {}) {
  const granted = new Set(options.grantedRoots ?? []);
  return new ModalAnswerPolicy({
    grants: { allowsRoot: async (root) => granted.has(root) },
    probe: {
      gitCommonDirectory: async (path) => options.commonDir?.[path],
      primaryWorktree: async (gitDir) => options.primaryWorktree?.[gitDir],
    },
    canonicalize: async (path) => path,
  });
}

describe("ModalAnswerPolicy", () => {
  it("uses broker-resolved clone provenance, honors revocation and refuses missing provenance", async () => {
    let granted = true, source: string | undefined = "/repo";
    const guarded = new ModalAnswerPolicy({
      grants: { allowsRoot: async (root) => granted && root === "/repo" },
      probe: { gitCommonDirectory: async (cwd) => `${cwd}/.git`, primaryWorktree: async () => undefined },
      canonicalize: async (path) => path,
      resolveSessionCwd: async (id, cwd) => id === "worker" && cwd === "/private/clone" ? source : undefined,
    });
    const input = { cwd: "/private/clone", sessionId: "worker", kind: "workspace-trust" as const };
    expect(await guarded.evaluate(input)).toMatchObject({ allowed: true, root: "/repo" });
    for (const kind of ["login", "unknown", "permission-approval"] as const) {
      expect((await guarded.evaluate({ ...input, kind })).allowed).toBe(false);
    }
    granted = false;
    expect((await guarded.evaluate(input)).allowed).toBe(false);
    granted = true; source = undefined;
    expect((await guarded.evaluate(input)).allowed).toBe(false);
  });
  it("allows an answerable kind when the grant covers the primary checkout root", async () => {
    const decision = await policy({
      grantedRoots: ["/repo"],
      commonDir: { "/repo": "/repo/.git" },
    }).evaluate({ cwd: "/repo", kind: "workspace-trust" });
    expect(decision).toMatchObject({ allowed: true, root: "/repo" });
  });

  it("resolves a linked worktree to the repository the grant was set on", async () => {
    // From a linked worktree, `git rev-parse --git-common-dir` names the primary `.git`.
    const decision = await policy({
      grantedRoots: ["/repo"],
      commonDir: { "/repo/worktrees/fix": "/repo/.git" },
    }).evaluate({ cwd: "/repo/worktrees/fix", kind: "plan-confirm" });
    expect(decision).toMatchObject({ allowed: true, root: "/repo" });
  });

  it("asks git for the primary worktree when the common dir is not <root>/.git", async () => {
    const decision = await policy({
      grantedRoots: ["/elsewhere/main"],
      commonDir: { "/repo": "/separate/git-dir" },
      primaryWorktree: { "/separate/git-dir": "/elsewhere/main" },
    }).evaluate({ cwd: "/repo", kind: "workspace-trust" });
    expect(decision).toMatchObject({ allowed: true, root: "/elsewhere/main" });
  });

  it("never allows kinds outside the answerable set, grant or no grant", async () => {
    const guarded = policy({ grantedRoots: ["/repo"], commonDir: { "/repo": "/repo/.git" } });
    for (const kind of ["permission-approval", "login", "unknown"] as const) {
      const decision = await guarded.evaluate({ cwd: "/repo", kind });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("never answerable");
    }
  });

  it("denies when no grant covers the resolved root, naming the fix", async () => {
    const decision = await policy({ commonDir: { "/repo": "/repo/.git" } })
      .evaluate({ cwd: "/repo", kind: "workspace-trust" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("cyberdeck modal-answers on --root /repo");
  });

  it("denies outside any git repository", async () => {
    const decision = await policy().evaluate({ cwd: "/tmp/scratch", kind: "workspace-trust" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("does not resolve to a Git repository");
  });

  it("gates provision-time workspace trust through the same evaluation", async () => {
    const guarded = policy({ grantedRoots: ["/repo"], commonDir: { "/repo": "/repo/.git" } });
    expect(await guarded.allowsWorkspaceTrust("/repo")).toBe(true);
    expect(await guarded.allowsWorkspaceTrust("/other")).toBe(false);
  });
});
