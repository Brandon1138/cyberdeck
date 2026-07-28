import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalScoutRepositoryRoot,
  captureScoutWorkspaceStateHash,
} from "../../src/providers/cursor/workspace-state.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("Cursor Scout workspace state", () => {
  it("requires the exact Git root and detects tracked or untracked state changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-scout-git-"));
    directories.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);
    const child = join(root, "src");
    await mkdir(child);

    await expect(canonicalScoutRepositoryRoot(root)).resolves.toBe(await realpath(root));
    await expect(canonicalScoutRepositoryRoot(child)).rejects.toThrow(
      "must be the exact Git repository root",
    );
    const before = await captureScoutWorkspaceStateHash(root);
    await writeFile(join(root, "new-file.txt"), "mutation\n");
    const after = await captureScoutWorkspaceStateHash(root);
    expect(after).not.toBe(before);

    await execFileAsync("git", ["-C", root, "add", "new-file.txt"]);
    await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "user.name=Cyberdeck Test",
      "-c",
      "user.email=cyberdeck@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    await writeFile(join(root, "new-file.txt"), "dirty before Scout\n");
    const dirtyBefore = await captureScoutWorkspaceStateHash(root);
    await writeFile(join(root, "new-file.txt"), "dirty after Scout\n");
    const dirtyAfter = await captureScoutWorkspaceStateHash(root);
    expect(dirtyAfter).not.toBe(dirtyBefore);
  });
});
