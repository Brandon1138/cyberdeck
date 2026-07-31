import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FleetProjectService } from "../../src/broker/fleet-project-service.js";
import type { GitOutput } from "../../src/nvim/worktree-changes.js";
import { FleetPreferenceStore } from "../../src/persistence/fleet-preference-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface GitFacts {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

/** A repository: `--git-dir` and `--git-common-dir` agree, so nothing is linked. */
function repository(toplevel: string): GitFacts {
  return { toplevel, gitDir: `${toplevel}/.git`, commonDir: `${toplevel}/.git` };
}

/** A linked worktree: its own `--git-dir` under the repository's common `.git`. */
function linkedWorktree(toplevel: string, repositoryRoot: string): GitFacts {
  return {
    toplevel,
    gitDir: `${repositoryRoot}/.git/worktrees/${toplevel.split("/").pop()}`,
    commonDir: `${repositoryRoot}/.git`,
  };
}

/** Git as the service sees it, so resolution is exercised without repositories on disk. */
function fakeGit(facts: Record<string, GitFacts>): (cwd: string) => GitOutput {
  return (cwd: string) => async (args: readonly string[]) => {
    const entry = Object.entries(facts)
      .filter(([path]) => cwd === path || cwd.startsWith(`${path}/`))
      .sort(([left], [right]) => right.length - left.length)[0]?.[1];
    if (entry === undefined) throw new Error(`not a git repository: ${cwd}`);
    if (args[1] === "--show-toplevel") return `${entry.toplevel}\n`;
    if (args[1] === "--git-dir") return `${entry.gitDir}\n`;
    if (args[1] === "--git-common-dir") return `${entry.commonDir}\n`;
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

async function serviceWith(facts: Record<string, GitFacts>) {
  const directory = await mkdtemp(join(tmpdir(), "cyberdeck-fleet-projects-"));
  directories.push(directory);
  const store = new FleetPreferenceStore(directory);
  return { store, service: new FleetProjectService({ store, gitIn: fakeGit(facts) }) };
}

describe("FleetProjectService", () => {
  describe("seed", () => {
    it("registers the repositories behind existing threads and nothing else", async () => {
      // The operator's real shape: six repositories, plus per-task worktrees and a scratch
      // directory that must not become sections of their own.
      const { service } = await serviceWith({
        "/code/personal/ammo": repository("/code/personal/ammo"),
        "/code/personal/cyberdeck": repository("/code/personal/cyberdeck"),
        "/code/work/iron-kasa": repository("/code/work/iron-kasa"),
        "/code/personal/ammo-worktrees/feature": linkedWorktree(
          "/code/personal/ammo-worktrees/feature",
          "/code/personal/ammo",
        ),
        "/code/personal/cd-mik64-delivery": linkedWorktree(
          "/code/personal/cd-mik64-delivery",
          "/code/personal/cyberdeck",
        ),
      });

      const result = await service.seed([
        "/code/personal/ammo",
        "/code/personal/cyberdeck",
        "/code/personal/cyberdeck/src/client",
        "/code/work/iron-kasa",
        "/code/personal/ammo-worktrees/feature",
        "/code/personal/cd-mik64-delivery",
        "/private/tmp/scratchpad",
      ]);

      expect(result.seeded).toBe(true);
      expect(result.roots).toEqual([
        "/code/personal/ammo",
        "/code/personal/cyberdeck",
        "/code/work/iron-kasa",
      ]);
      await expect(service.list()).resolves.toEqual([
        "/code/personal/ammo",
        "/code/personal/cyberdeck",
        "/code/work/iron-kasa",
      ]);
    });

    it("runs once, so a later thread in a new repository does not reopen the migration", async () => {
      const { service } = await serviceWith({
        "/code/one": repository("/code/one"),
        "/code/two": repository("/code/two"),
      });

      await service.seed(["/code/one"]);
      const second = await service.seed(["/code/two"]);

      expect(second).toEqual({ seeded: false, roots: [] });
      await expect(service.list()).resolves.toEqual(["/code/one"]);
    });

    it("leaves a removed repository removed even while its threads still point inside it", async () => {
      const { store, service } = await serviceWith({ "/code/one": repository("/code/one") });
      await store.setProject("/code/one", false);

      const result = await service.seed(["/code/one"]);

      expect(result.roots).toEqual([]);
      await expect(service.list()).resolves.toEqual([]);
    });

    it("ignores git's own directory, which is never a project", async () => {
      const { service } = await serviceWith({ "/code/one": repository("/code/one") });

      const result = await service.seed(["/code/one/.git/worktrees/x", "/code/one/.git"]);

      expect(result.roots).toEqual([]);
    });
  });

  describe("add", () => {
    it("offers the repository and writes nothing when handed a linked worktree", async () => {
      const { service } = await serviceWith({
        "/code/one": repository("/code/one"),
        "/code/one-wt": linkedWorktree("/code/one-wt", "/code/one"),
      });

      await expect(service.add({ path: "/code/one-wt" })).resolves.toEqual({
        status: "worktree",
        root: "/code/one",
        toplevel: "/code/one-wt",
      });
      await expect(service.list()).resolves.toEqual([]);
    });

    it("registers the repository once the operator accepts the parent", async () => {
      const { service } = await serviceWith({
        "/code/one": repository("/code/one"),
        "/code/one-wt": linkedWorktree("/code/one-wt", "/code/one"),
      });

      await expect(service.add({ path: "/code/one-wt", acceptParent: true })).resolves.toEqual({
        status: "registered",
        root: "/code/one",
        toplevel: "/code/one-wt",
        alreadyRegistered: false,
      });
      await expect(service.list()).resolves.toEqual(["/code/one"]);
    });

    it("registers the top-level for a path inside a repository, and reports a repeat as such", async () => {
      const { service } = await serviceWith({ "/code/one": repository("/code/one") });

      const first = await service.add({ path: "/code/one/src/deep" });
      const second = await service.add({ path: "/code/one" });

      expect(first).toMatchObject({ root: "/code/one", alreadyRegistered: false });
      expect(second).toMatchObject({ root: "/code/one", alreadyRegistered: true });
      await expect(service.list()).resolves.toEqual(["/code/one"]);
    });

    it("refuses a path git has no repository for", async () => {
      const { service } = await serviceWith({});

      await expect(service.add({ path: "/not/a/repo" })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
    });
  });

  describe("remove", () => {
    it("unregisters a repository without consulting git", async () => {
      const { store, service } = await serviceWith({});
      await store.setProject("/code/one", true);

      await expect(service.remove({ path: "/code/one" })).resolves.toEqual({
        removed: true,
        root: "/code/one",
      });
      await expect(service.list()).resolves.toEqual([]);
    });

    it("unregisters the repository when pointed at a path inside it", async () => {
      const { service } = await serviceWith({ "/code/one": repository("/code/one") });
      await service.add({ path: "/code/one" });

      await expect(service.remove({ path: "/code/one/src" })).resolves.toEqual({
        removed: true,
        root: "/code/one",
      });
      await expect(service.list()).resolves.toEqual([]);
    });

    it("reports nothing removed for a repository that was never registered", async () => {
      const { service } = await serviceWith({ "/code/one": repository("/code/one") });

      await expect(service.remove({ path: "/code/one" })).resolves.toEqual({
        removed: false,
        root: "/code/one",
      });
    });
  });

  it("treats a bare repository as its own root rather than guessing at its parent", async () => {
    // A common directory that is not named `.git` has no working tree to offer instead.
    const { service } = await serviceWith({
      "/code/bare": { toplevel: "/code/bare", gitDir: "/srv/bare.git", commonDir: "/srv/bare.git" },
    });

    await expect(service.add({ path: "/code/bare" })).resolves.toMatchObject({
      status: "registered",
      root: "/code/bare",
    });
  });
});
