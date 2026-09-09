import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IsolatedWorkspaceRequest } from "../../orchestration/isolated-workspace-provisioner.js";
import { contentHash, safeRelativePath, workspaceManifest } from "./workspace-manifest.js";
import { trustedGit } from "./trusted-git.js";

/** Every changed nonignored path must be explicitly selected; agent prose never supplies truth. */
export async function verifySelectedInput(input: IsolatedWorkspaceRequest, clone: string): Promise<void> {
  const baseline = new Map((await workspaceManifest(clone)).map((fact) => [fact.path, fact]));
  const listed = (await trustedGit(input.source, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).toString().split("\0").filter(Boolean);
  const selected = new Map(input.inputs.map((file) => [file.path, file]));
  if (selected.size !== input.inputs.length) throw new Error("WORKSPACE_INPUT_DUPLICATE");
  const known = new Set(listed);
  for (const path of baseline.keys()) known.add(path);
  for (const path of selected.keys()) if (!known.has(path)) throw new Error("WORKSPACE_INPUT_IGNORED_OR_UNKNOWN");
  let bytes = 0;
  for (const path of known) {
    safeRelativePath(path);
    let cursor = input.source;
    for (const part of path.split("/").slice(0, -1)) {
      cursor = join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("WORKSPACE_SYMLINK_ESCAPE"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    let stat;
    try { stat = await lstat(join(input.source, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const previous = baseline.get(path), file = selected.get(path);
    if (stat === undefined) {
      if (previous !== undefined && file?.action !== "delete") throw new Error("WORKSPACE_DIRTY_INPUT_REQUIRED");
      continue;
    }
    if (stat.isSymbolicLink()) {
      // Unchanged in-tree symlinks are valid; selected symlink modifications require a separate contract.
      const { readlink } = await import("node:fs/promises");
      if (previous?.kind === "symlink" && previous.sha256 === contentHash(await readlink(join(input.source, path))) && file === undefined) continue;
      throw new Error("WORKSPACE_SYMLINK_INPUT_UNSUPPORTED");
    }
    if (!stat.isFile()) throw new Error("WORKSPACE_SPECIAL_FILE_REFUSED");
    bytes += stat.size;
    if (bytes > 512 * 1024 * 1024) throw new Error("WORKSPACE_CAPTURE_LIMIT");
    const hash = contentHash(await readFile(join(input.source, path)));
    const executable = (stat.mode & 0o111) !== 0;
    const dirty = previous?.sha256 !== hash || previous.executable !== executable;
    if (dirty && file === undefined) throw new Error("WORKSPACE_DIRTY_INPUT_REQUIRED");
    if (file !== undefined && (file.action === "delete" || file.sha256 !== hash || file.executable !== executable)) throw new Error("WORKSPACE_INPUT_CHANGED");
  }
}
