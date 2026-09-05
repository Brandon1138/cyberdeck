import { verifySelectedInput } from "./selected-workspace-input.js";
import { mkdir, lstat, writeFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { IsolatedWorkspace, IsolatedWorkspaceProvisioner, IsolatedWorkspaceRequest } from "../../orchestration/isolated-workspace-provisioner.js";
import { trustedGit } from "./trusted-git.js";
import { contentHash, safeRelativePath, workspaceManifest } from "./workspace-manifest.js";

/** A fresh independent clone, never a shared linked-worktree metadata mount. */
export class PrivateCloneProvisioner implements IsolatedWorkspaceProvisioner {
  constructor(private readonly root: string) {}
  async provision(input: IsolatedWorkspaceRequest): Promise<IsolatedWorkspace> {
    z.uuid().parse(input.executionId);
    if (!isAbsolute(input.source) || !/^[a-f0-9]{40}$/.test(input.baseCommit)) throw new Error("WORKSPACE_BASE_INVALID");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,200}$/.test(input.branch)) throw new Error("WORKSPACE_BRANCH_INVALID");
    const base = (await trustedGit(input.source, ["rev-parse", "--verify", "--end-of-options", `${input.baseCommit}^{commit}`])).toString().trim();
    if (base !== input.baseCommit) throw new Error("WORKSPACE_BASE_MISMATCH");
    const final = join(this.root, input.executionId), staging = `${final}.preparing`;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Exclusive creation is the ownership proof; never remove a pre-existing staging directory.
    await mkdir(staging, { mode: 0o700 });
    let changed = false;
    try {
      await trustedGit(this.root, ["clone", "--no-local", "--no-checkout", "--", input.source, staging]);
      await trustedGit(staging, ["checkout", "--no-recurse-submodules", "-b", input.branch, input.baseCommit]);
      if (!(await lstat(join(staging, ".git"))).isDirectory()) throw new Error("WORKSPACE_GIT_NOT_PRIVATE");
      await verifySelectedInput(input, staging);
      const seen = new Set<string>();
      for (const file of input.inputs) {
        safeRelativePath(file.path);
        if (seen.has(file.path) || (file.action === "write" && contentHash(Buffer.from(file.bytes)) !== file.sha256)) throw new Error("WORKSPACE_INPUT_MISMATCH");
        seen.add(file.path);
        let cursor = staging;
        const parts = file.path.split("/");
        for (const part of parts.slice(0, -1)) {
          cursor = join(cursor, part);
          try { if (!(await lstat(cursor)).isDirectory()) throw new Error("WORKSPACE_PATH_REFUSED"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(cursor); }
        }
        const target = join(staging, file.path);
        try { if ((await lstat(target)).isSymbolicLink()) throw new Error("WORKSPACE_PATH_REFUSED"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        changed = true;
        if (file.action === "delete") { await rm(target, { force: true }); continue; }
        await writeFile(target, file.bytes, { mode: file.executable ? 0o700 : 0o600 });
      }
      const manifest = await workspaceManifest(staging);
      const result: IsolatedWorkspace = { mode: "independent-clone", executionId: input.executionId,
        hostPath: final, guestPath: "/workspace", source: input.source, baseCommit: base, branch: input.branch,
        manifestHash: contentHash(JSON.stringify(manifest)) };
      // rename refuses a nonempty existing clone; explicitly reject any existing target first.
      try { await lstat(final); throw new Error("WORKSPACE_TARGET_EXISTS"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(staging, final);
      await writeFile(join(this.root, `${input.executionId}.manifest.json`), JSON.stringify({ workspace: result, files: manifest }), { flag: "wx", mode: 0o600 });
      return result;
    } catch (error) {
      // Once selected user input was applied, retain it for inspection rather than deleting evidence.
      if (!changed) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}
