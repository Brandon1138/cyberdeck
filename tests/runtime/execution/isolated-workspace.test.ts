import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { PrivateCloneProvisioner } from "../../../src/runtime/execution/isolated-workspace.js";
import { trustedGit } from "../../../src/runtime/execution/trusted-git.js";
import { contentHash, workspaceManifest } from "../../../src/runtime/execution/workspace-manifest.js";
import { worktreeChanges } from "../../../src/nvim/worktree-changes.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cyberdeck-private-clone-")); dirs.push(root);
  const source = join(root, "source with spaces"); await mkdir(source);
  await trustedGit(source, ["init", "-b", "main"]);
  await trustedGit(source, ["config", "user.email", "fixture@example.invalid"]);
  await trustedGit(source, ["config", "user.name", "Fixture"]);
  await writeFile(join(source, "answer.txt"), "before");
  await writeFile(join(source, ".gitignore"), "ignored.txt\n");
  await trustedGit(source, ["add", "."]); await trustedGit(source, ["commit", "-m", "fixture"]);
  const baseCommit = (await trustedGit(source, ["rev-parse", "HEAD"])).toString().trim();
  return { root, source, baseCommit, executionId: randomUUID(), branch: "worker/test", inputs: [] };
}
it("clones a linked worktree into independent private Git metadata", async () => {
  const f = await fixture(), linked = join(f.root, "linked source");
  await trustedGit(f.source, ["worktree", "add", "-b", "input", linked]);
  const clone = await new PrivateCloneProvisioner(join(f.root, "workers")).provision({ ...f, source: linked });
  expect((await lstat(join(clone.hostPath, ".git"))).isDirectory()).toBe(true);
  expect((await trustedGit(clone.hostPath, ["rev-parse", "HEAD"])).toString().trim()).toBe(f.baseCommit);
  await writeFile(join(clone.hostPath, "answer.txt"), "private");
  expect(await readFile(join(linked, "answer.txt"), "utf8")).toBe("before");
});
it("requires exact dirty inputs, excludes ignored files, and verifies source hashes", async () => {
  const f = await fixture();
  await writeFile(join(f.source, "answer.txt"), "changed"); await writeFile(join(f.source, "new.txt"), "new");
  await writeFile(join(f.source, "ignored.txt"), "secret");
  const provisioner = new PrivateCloneProvisioner(join(f.root, "workers"));
  await expect(provisioner.provision(f)).rejects.toThrow("WORKSPACE_DIRTY_INPUT_REQUIRED");
  const inputs = [["answer.txt", "changed"], ["new.txt", "new"]].map(([path, body]) => ({
    path: path!, action: "write" as const, bytes: Buffer.from(body!), sha256: contentHash(body!), executable: false,
  }));
  const clone = await provisioner.provision({ ...f, inputs });
  expect(await readFile(join(clone.hostPath, "new.txt"), "utf8")).toBe("new");
  await expect(lstat(join(clone.hostPath, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("hostile source hooks/fsmonitor never run and collection ignores worker Git config", async () => {
  const f = await fixture(), sentinel = join(f.root, "executed");
  await trustedGit(f.source, ["config", "core.fsmonitor", `touch '${sentinel}'`]);
  await writeFile(join(f.source, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
  const clone = await new PrivateCloneProvisioner(join(f.root, "workers")).provision(f);
  await writeFile(join(clone.hostPath, ".git", "config"), `[core]\nfsmonitor = touch '${sentinel}'\n[diff]\nexternal = touch '${sentinel}'\n`);
  expect(await workspaceManifest(clone.hostPath)).toHaveLength(2);
  await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects escaping symlinks and preserves an existing target", async () => {
  const f = await fixture();
  await symlink("/etc/passwd", join(f.source, "escape"));
  await trustedGit(f.source, ["add", "escape"]); await trustedGit(f.source, ["commit", "-m", "symlink"]);
  f.baseCommit = (await trustedGit(f.source, ["rev-parse", "HEAD"])).toString().trim();
  await expect(new PrivateCloneProvisioner(join(f.root, "workers")).provision(f)).rejects.toThrow("WORKSPACE_SYMLINK_ESCAPE");
});
it("reviewing worker changes disables fsmonitor, external diff and textconv execution", async () => {
  const f = await fixture(), sentinel = join(f.root, "review-executed"), helper = join(f.root, "hostile-helper");
  await writeFile(helper, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o700 });
  await trustedGit(f.source, ["update-ref", "refs/remotes/origin/main", f.baseCommit]);
  await trustedGit(f.source, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await trustedGit(f.source, ["config", "core.fsmonitor", helper]);
  await trustedGit(f.source, ["config", "diff.external", helper]);
  await trustedGit(f.source, ["config", "diff.hostile.textconv", helper]);
  await writeFile(join(f.source, ".gitattributes"), "answer.txt diff=hostile\n");
  await writeFile(join(f.source, "answer.txt"), "review me\n");
  const changes = await worktreeChanges(f.source);
  expect(changes.changes.some((change) => change.path === "answer.txt")).toBe(true);
  await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
});
