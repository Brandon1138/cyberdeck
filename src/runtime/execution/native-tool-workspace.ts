import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { contentHash, safeRelativePath, type WorkspaceFileFact } from "./workspace-manifest.js";

export function nativeManifestHash(manifest: WorkspaceFileFact[]): string {
  return contentHash(JSON.stringify([...manifest].sort((a, b) => a.path.localeCompare(b.path))));
}
export async function writeNativeRecord(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
/** Copies only hash-pinned regular files, refusing symlinks including ancestor substitutions. */
export async function prepareNativeWorkspace(root: string, source: string, manifest: WorkspaceFileFact[], maxBytes: number): Promise<void> {
  if (!manifest.length || manifest.length > 10000) throw new Error("native-input-count");
  const canonical = await realpath(source);
  let total = 0;
  const seen = new Set<string>();
  await mkdir(root, { recursive: false, mode: 0o700 });
  for (const fact of manifest) {
    safeRelativePath(fact.path);
    if (seen.has(fact.path) || fact.kind !== "file" || !Number.isSafeInteger(fact.bytes) || fact.bytes < 0)
      throw new Error("native-input-kind-or-duplicate");
    seen.add(fact.path);
    total += fact.bytes;
    if (total > maxBytes) throw new Error("native-input-quota");
    const input = join(canonical, fact.path);
    const parent = await realpath(dirname(input));
    if (parent !== canonical && !parent.startsWith(`${canonical}${sep}`)) throw new Error("native-input-escape");
    // Reject all symlink ancestors, even those that resolve within the source tree.
    let component = canonical;
    for (const part of fact.path.split("/").slice(0, -1)) {
      component = join(component, part);
      if ((await lstat(component)).isSymbolicLink()) throw new Error("native-input-symlink");
    }
    const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
    let body: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== fact.bytes) throw new Error("native-input-changed");
      body = await file.readFile();
      if (body.length !== fact.bytes || contentHash(body) !== fact.sha256) throw new Error("native-input-changed");
    } finally { await file.close(); }
    const output = resolve(root, fact.path);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, body, { flag: "wx", mode: fact.executable ? 0o500 : 0o400 });
    await chmod(output, fact.executable ? 0o500 : 0o400);
  }
}
