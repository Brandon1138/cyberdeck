import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultApplyWorkerMode,
  defaultJobLaunchEnvironment,
} from "../../src/app-server/dispatch-defaults.js";
import { jobLaunchEnvironment } from "../../src/providers/launch-environment.js";
import { applyWorkerMode } from "../../src/providers/worker-mode.js";

/**
 * `src/app-server/dispatch-defaults.ts` restates the worker launch environment and the caveman
 * worker-mode policy so the delivery-layer adapter never imports the infrastructure that owns them;
 * the composition root injects the real `providers/` implementations instead. Nothing in the type
 * system keeps those two statements of the same rule in step, so it is pinned here: a key added to
 * one allowlist, or a marker string changed on one side, fails this file rather than silently
 * splitting production from every test that constructs the adapter without injection.
 */

/**
 * A source environment that answers every name asked of it with that name. Both implementations
 * copy by exact key, so the returned object *is* the key list each one asked for — which makes the
 * comparison sensitive to a key added or dropped on either side, not just to the keys guessed here.
 */
const everyKey = new Proxy({} as NodeJS.ProcessEnv, {
  get: (_target, property) => (typeof property === "string" ? property : undefined),
});

const PROVIDERS = ["codex", "claude", "cursor", "antigravity", "unregistered-provider"];

describe("app-server dispatch defaults restate the provider implementations", () => {
  it.each(PROVIDERS)("builds the same worker launch environment for %s", (provider) => {
    for (const workerMode of ["normal", "caveman", undefined] as const) {
      const request = { cwd: "/tmp/worktree", ...(workerMode === undefined ? {} : { workerMode }) };
      expect(defaultJobLaunchEnvironment(everyKey, provider, request)).toEqual(
        jobLaunchEnvironment(everyKey, provider, request),
      );
    }
  });

  it("drops the same unlisted names from a realistic source environment", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/Users/operator",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
      TMUX: "/tmp/tmux-501/default,1,0",
      UNRELATED_SENTINEL: "leaked",
    };
    const request = { cwd: "/tmp/worktree", workerMode: "normal" as const };
    const built = defaultJobLaunchEnvironment(source, "claude", request);
    expect(built).toEqual(jobLaunchEnvironment(source, "claude", request));
    expect(built.UNRELATED_SENTINEL).toBeUndefined();
    expect(built.TMUX).toBeUndefined();
  });

  it("applies the same worker-mode policy, skill or no skill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cyberdeck-dispatch-defaults-"));
    const skillPath = join(directory, "SKILL.md");
    await writeFile(skillPath, "---\nname: caveman\n---\nDrop articles. Keep code exact.\n");

    const environments = [
      { CYBERDECK_CAVEMAN_SKILL: skillPath },
      { CYBERDECK_CAVEMAN_SKILL: "/definitely/missing/caveman-skill.md" },
      {},
    ];
    for (const environment of environments) {
      for (const mode of ["normal", "caveman", undefined] as const) {
        expect(defaultApplyWorkerMode("Answer precisely.", mode, environment)).toBe(
          applyWorkerMode("Answer precisely.", mode, environment),
        );
      }
    }
  });

  it("shares one marker, so neither implementation re-applies the other's policy", () => {
    const environment = { CYBERDECK_CAVEMAN_SKILL: "/definitely/missing/caveman-skill.md" };
    const applied = applyWorkerMode("Answer precisely.", "caveman", environment);
    expect(defaultApplyWorkerMode(applied, "caveman", environment)).toBe(applied);
    expect(applyWorkerMode(
      defaultApplyWorkerMode("Answer precisely.", "caveman", environment),
      "caveman",
      environment,
    )).toBe(applied);
  });
});
