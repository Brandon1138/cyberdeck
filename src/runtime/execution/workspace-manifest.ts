import { createHash } from "node:crypto";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export interface WorkspaceFileFact { path: string; kind: "file" | "symlink"; sha256: string; bytes: number; executable: boolean }
export function contentHash(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
export function safeRelativePath(path: string): void {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === ".git" || part === ".." || part === "." || part === "")) {
    throw new Error("WORKSPACE_PATH_REFUSED");
  }
}
/** Host filesystem facts never invoke Git, filters, hooks, fsmonitor or textconv. */
export async function workspaceManifest(root: string, maxBytes = 512 * 1024 * 1024, allowExternalSymlinkTargets = false): Promise<WorkspaceFileFact[]> {
  const result: WorkspaceFileFact[] = [];
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(directory, entry.name), path = relative(root, absolute).split(sep).join("/");
      safeRelativePath(path);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) { await visit(absolute); continue; }
      let body: Buffer;
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute);
        const resolved = resolve(directory, target);
        if (!allowExternalSymlinkTargets && resolved !== resolve(root) && !resolved.startsWith(`${resolve(root)}${sep}`)) throw new Error("WORKSPACE_SYMLINK_ESCAPE");
        body = Buffer.from(target);
      } else if (stat.isFile()) {
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat();
          if (before.size > maxBytes - bytes) throw new Error("WORKSPACE_CAPTURE_LIMIT");
          body = await handle.readFile();
          const after = await handle.stat();
          if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("WORKSPACE_CHANGED_DURING_CAPTURE");
        } finally { await handle.close(); }
      } else { throw new Error("WORKSPACE_SPECIAL_FILE_REFUSED"); }
      bytes += body.length;
      if (bytes > maxBytes) throw new Error("WORKSPACE_CAPTURE_LIMIT");
      result.push({ path, kind: stat.isSymbolicLink() ? "symlink" : "file", sha256: contentHash(body), bytes: body.length, executable: (stat.mode & 0o111) !== 0 });
    }
  }
  await visit(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
