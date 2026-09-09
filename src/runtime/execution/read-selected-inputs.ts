import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { WorkspaceInputSelection } from "../../domain/workspace-input.js";
import type { IsolatedWorkspaceRequest } from "../../orchestration/isolated-workspace-provisioner.js";
import { contentHash, safeRelativePath } from "./workspace-manifest.js";

/** Request carries selection/hashes only. Bytes come from the declared source under host checks. */
export async function readSelectedInputs(source: string, selections: readonly WorkspaceInputSelection[] = []): Promise<IsolatedWorkspaceRequest["inputs"]> {
  const inputs: IsolatedWorkspaceRequest["inputs"] = [];
  let total = 0;
  for (const selection of selections) {
    safeRelativePath(selection.path);
    let parent = source;
    for (const part of selection.path.split("/").slice(0, -1)) {
      parent = join(parent, part);
      try { if (!(await lstat(parent)).isDirectory()) throw new Error("WORKSPACE_SYMLINK_ESCAPE"); }
      catch (error) { if (selection.action !== "delete" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const path = join(source, selection.path);
    if (selection.action === "delete") {
      try { await lstat(path); throw new Error("WORKSPACE_INPUT_CHANGED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      inputs.push(selection); continue;
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat(); total += stat.size;
      if (!stat.isFile() || stat.size > 64 * 1024 ** 2 || total > 512 * 1024 ** 2) throw new Error("WORKSPACE_CAPTURE_LIMIT");
      const bytes = await file.readFile();
      if (contentHash(bytes) !== selection.sha256 || ((stat.mode & 0o111) !== 0) !== selection.executable) throw new Error("WORKSPACE_INPUT_CHANGED");
      inputs.push({ ...selection, bytes });
    } finally { await file.close(); }
  }
  return inputs;
}
