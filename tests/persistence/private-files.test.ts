import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePrivateDirectory,
  openPrivateAppendFile,
} from "../../src/persistence/private-files.js";

describe("private state permissions", () => {
  it("creates and repairs state directories as user-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-private-directory-"));
    const directory = join(root, "state");

    await ensurePrivateDirectory(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);

    await chmod(directory, 0o755);
    await ensurePrivateDirectory(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("creates and repairs append-only state files as user-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "cyberdeck-private-file-"));
    const path = join(root, "state", "events.jsonl");
    let handle = await openPrivateAppendFile(path);
    await handle.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await chmod(path, 0o644);
    handle = await openPrivateAppendFile(path);
    await handle.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
