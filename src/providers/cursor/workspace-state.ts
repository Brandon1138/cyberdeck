import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Resolve an exact repository root. Scout grants do not inherit into subdirectories, sibling
 * worktrees, symlink aliases, or parent directories.
 */
export async function canonicalScoutRepositoryRoot(path: string): Promise<string> {
  const canonical = await realpath(path);
  const { stdout } = await execFileAsync(
    "git",
    ["--no-optional-locks", "-C", canonical, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
  );
  const repositoryRoot = await realpath(stdout.trim());
  if (repositoryRoot !== canonical) {
    throw new Error(
      `Scout egress root must be the exact Git repository root: ${repositoryRoot}`,
    );
  }
  return repositoryRoot;
}

/**
 * Fingerprint observable tracked and untracked Git worktree state. Status alone is insufficient:
 * changing the contents of an already-dirty file can leave its porcelain line identical. Include
 * HEAD, status, the binary tracked diff, and the bytes of every nonignored untracked file.
 *
 * The provider's plan+sandbox boundary is primary enforcement; comparing this fingerprint after
 * exit makes any observable mutation a failed Scout result rather than trusting model-authored
 * prose. Ignored paths are deliberately excluded because dependency trees can be unbounded and
 * Cursor's own writable state is redirected outside the repository.
 */
export async function captureScoutWorkspaceStateHash(cwd: string): Promise<string> {
  const root = await canonicalScoutRepositoryRoot(cwd);
  const [head, status, trackedDiff, untracked] = await Promise.all([
    gitOutput(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "UNBORN\n"),
    gitOutput(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    trackedWorktreeDiff(root),
    gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const hash = createHash("sha256");
  hash.update("HEAD\0").update(head);
  hash.update("\0STATUS\0").update(status);
  hash.update("\0TRACKED_DIFF\0").update(trackedDiff);
  hash.update("\0UNTRACKED\0");
  const paths = untracked.split("\0").filter((path) => path !== "").sort();
  for (const path of paths) {
    const absolute = resolve(root, path);
    const contained = relative(root, absolute);
    if (contained === ".." || contained.startsWith("../") || isAbsolute(contained)) {
      throw new Error(`Git returned an untracked path outside Scout root: ${path}`);
    }
    const metadata = await lstat(absolute);
    hash.update(path).update("\0").update(String(metadata.mode)).update("\0");
    if (metadata.isSymbolicLink()) {
      hash.update("symlink\0").update(await readlink(absolute)).update("\0");
    } else if (metadata.isFile()) {
      hash.update("file\0");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      hash.update("\0");
    } else {
      hash.update(`special:${metadata.size}\0`);
    }
  }
  return hash.digest("hex");
}

async function trackedWorktreeDiff(root: string): Promise<string> {
  const hasHead = await gitOutput(root, ["rev-parse", "--verify", "HEAD"])
    .then(() => true, () => false);
  if (hasHead) {
    return gitOutput(root, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]);
  }
  const [index, worktree] = await Promise.all([
    gitOutput(root, ["diff", "--no-ext-diff", "--binary", "--cached", "--"]),
    gitOutput(root, ["diff", "--no-ext-diff", "--binary", "--"]),
  ]);
  return `${index}\0${worktree}`;
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["--no-optional-locks", ...args],
    { cwd: root, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
  );
  return stdout;
}
