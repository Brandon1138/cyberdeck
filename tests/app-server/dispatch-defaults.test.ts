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
const PLATFORMS = ["linux", "darwin"] as const;
const LINUX_SESSION_ENV = {
  DISPLAY: ":0",
  WAYLAND_DISPLAY: "wayland-0",
  XAUTHORITY: "/home/operator/.Xauthority",
  XDG_RUNTIME_DIR: "/run/user/1000",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  XDG_DATA_HOME: "/home/operator/.local/share",
  WSL_INTEROP: "/run/WSL/123_interop",
  WSL_DISTRO_NAME: "Ubuntu",
};

describe("app-server dispatch defaults restate the provider implementations", () => {
  it.each(PROVIDERS.flatMap((provider) => PLATFORMS.map((platform) => ({ provider, platform }))))(
    "builds the same worker launch environment for $provider on $platform",
    ({ provider, platform }) => {
      for (const workerMode of ["normal", "caveman", undefined] as const) {
        const request = { cwd: "/tmp/worktree", ...(workerMode === undefined ? {} : { workerMode }) };
        expect(defaultJobLaunchEnvironment(everyKey, provider, request, { platform })).toEqual(
          jobLaunchEnvironment(everyKey, provider, request, { platform }),
        );
      }
    },
  );

  it("defaults to the host platform", () => {
    const request = { cwd: "/tmp/worktree" };
    expect(defaultJobLaunchEnvironment(everyKey, "codex", request)).toEqual(
      jobLaunchEnvironment(everyKey, "codex", request),
    );
  });

  it.each(PLATFORMS)("preserves platform services and scrubs unlisted names on %s", (platform) => {
    const source = {
      ...LINUX_SESSION_ENV,
      PATH: "/usr/bin",
      HOME: "/Users/operator",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      WSLENV: "OPENAI_API_KEY/u",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      TMUX: "/tmp/tmux-501/default,1,0",
      UNRELATED_SENTINEL: "leaked",
    };
    const request = { cwd: "/tmp/worktree", workerMode: "normal" as const };
    const built = defaultJobLaunchEnvironment(source, "claude", request, { platform });
    expect(built).toEqual(jobLaunchEnvironment(source, "claude", request, { platform }));
    for (const [key, value] of Object.entries(LINUX_SESSION_ENV)) {
      expect(built[key]).toBe(platform === "linux" ? value : undefined);
    }
    for (const key of [
      "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "WSLENV", "SSH_AUTH_SOCK", "TMUX",
      "UNRELATED_SENTINEL",
    ]) {
      expect(built[key]).toBeUndefined();
    }
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
