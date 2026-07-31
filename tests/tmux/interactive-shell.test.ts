import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTERACTIVE_SHELL_ZSHENV,
  openInteractiveShell,
  type InteractiveShellSpawnSync,
} from "../../src/tmux/interactive-shell.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cyberdeck-interactive-shell-test-"));
  temporaryDirectories.push(path);
  return path;
}

function popupArguments(args: string[]): Map<string, string> {
  const environment = new Map<string, string>();
  for (const [index, argument] of args.entries()) {
    if (argument !== "-e") continue;
    const assignment = args[index + 1] ?? "";
    const split = assignment.indexOf("=");
    environment.set(assignment.slice(0, split), assignment.slice(split + 1));
  }
  return environment;
}

describe("tmux interactive shell", () => {
  it("opens the operator's login shell in a popup with no wrapper around it", async () => {
    const start = await temporaryDirectory();
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<InteractiveShellSpawnSync>((command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    });

    await expect(openInteractiveShell(start, {
      shell: "/bin/zsh",
      insideTmux: true,
      spawnSync,
      zdotdir: "/home/operator",
    })).resolves.toBeUndefined();

    const args = calls[0]?.args ?? [];
    expect(calls[0]?.command).toBe("tmux");
    expect(args.slice(0, 4)).toEqual(["display-popup", "-E", "-d", await realpath(start)]);
    // The shell is run interactively and as a login shell, and nothing is interposed: no script to
    // source, no REPL function, no allowlist.
    expect(args.slice(-2)).toEqual(["/bin/zsh", "-li"]);
    expect(args.some((argument) => argument.includes("source"))).toBe(false);
    const environment = popupArguments(args);
    // The popup runs under the tmux server's environment, so the handoff has to travel as -e.
    expect(environment.get("ZDOTDIR")).toMatch(/cyberdeck-shell-/u);
    expect(environment.get("CYBERDECK_SHELL_CWD")).toMatch(/final-cwd$/u);
    expect(environment.get("CYBERDECK_SHELL_ZDOTDIR")).toBe("/home/operator");
  });

  it("hands back the directory the shell recorded on its way out", async () => {
    const start = await temporaryDirectory();
    const selected = join(start, "selected path");
    await mkdir(selected);
    const spawnSync = vi.fn<InteractiveShellSpawnSync>((_command, args) => {
      const environment = popupArguments(args);
      writeFileSync(environment.get("CYBERDECK_SHELL_CWD")!, selected);
      return { status: 1 };
    });

    // A non-zero status is the operator's last command carried out through `exit`, not a fault:
    // the recorded directory still stands.
    await expect(openInteractiveShell(start, {
      shell: "/bin/zsh",
      insideTmux: true,
      spawnSync,
      zdotdir: "/home/operator",
    })).resolves.toBe(await realpath(selected));
  });

  it("runs a shell that is not zsh without pretending to capture its cwd", async () => {
    const start = await temporaryDirectory();
    const calls: string[][] = [];
    const spawnSync = vi.fn<InteractiveShellSpawnSync>((_command, args) => {
      calls.push(args);
      return { status: 0 };
    });

    await expect(openInteractiveShell(start, {
      shell: "/bin/bash",
      insideTmux: true,
      spawnSync,
    })).resolves.toBeUndefined();
    expect(calls[0]?.slice(-2)).toEqual(["/bin/bash", "-li"]);
    expect(popupArguments(calls[0] ?? []).size).toBe(0);
  });

  it("fails clearly outside tmux or without an absolute shell", async () => {
    await expect(openInteractiveShell("/tmp", {
      shell: "zsh",
      insideTmux: true,
    })).rejects.toMatchObject({ code: "INTERACTIVE_SHELL_UNSUPPORTED_SHELL" });
    await expect(openInteractiveShell("/tmp", {
      shell: "/bin/zsh",
      insideTmux: false,
    })).rejects.toMatchObject({ code: "INTERACTIVE_SHELL_REQUIRES_TMUX" });
  });

  it("records the cwd on exit and on every cd, and still runs the operator's own .zshenv", async () => {
    const root = await realpath(await temporaryDirectory());
    const real = join(root, "real-zdotdir");
    const ours = join(root, "our-zdotdir");
    const child = join(root, "child");
    await mkdir(real);
    await mkdir(ours);
    await mkdir(child);
    await writeFile(join(ours, ".zshenv"), INTERACTIVE_SHELL_ZSHENV);
    await writeFile(join(real, ".zshenv"), `printf 'sourced\\n' >| "${join(root, "sourced")}"\n`);
    const resultPath = join(root, "final-cwd");

    // `-i` without a tty is still the startup-file path the popup takes: .zshenv is read, the hooks
    // are installed, and the operator's own .zshenv is sourced from their real ZDOTDIR.
    await run("/bin/zsh", ["-lic", `builtin cd -- "${child}"; exit 0`], {
      cwd: root,
      env: {
        ...process.env,
        ZDOTDIR: ours,
        CYBERDECK_SHELL_ZDOTDIR: real,
        CYBERDECK_SHELL_CWD: resultPath,
      },
    });

    expect(await readFile(resultPath, "utf8")).toBe(child);
    expect(await readFile(join(root, "sourced"), "utf8")).toBe("sourced\n");
  });
});
