import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as pty from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseWorkingDirectory,
  CWD_NAVIGATOR_ZSH_SCRIPT,
  type CwdNavigatorSpawnSync,
} from "../../src/tmux/cwd-navigator.js";

const run = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "cyberdeck-cwd-navigator-test-"));
  temporaryDirectories.push(path);
  return path;
}

describe("tmux cwd navigator", () => {
  it("passes every dynamic value as a distinct argv item through a private result file", async () => {
    const start = await temporaryDirectory();
    const selected = join(start, "selected path");
    await mkdir(selected);
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnSync = vi.fn<CwdNavigatorSpawnSync>((command, args) => {
      calls.push({ command, args });
      writeFileSync(args.at(-1)!, selected);
      return { status: 0 };
    });

    await expect(chooseWorkingDirectory(start, {
      shell: "/bin/zsh",
      insideTmux: true,
      spawnSync,
    })).resolves.toBe(await realpath(selected));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("tmux");
    expect(calls[0]?.args.slice(0, 4)).toEqual(["display-popup", "-E", "-d", await realpath(start)]);
    const shellCommand = calls[0]?.args.find((argument) => argument.includes("source \"$1\"")) ?? "";
    expect(shellCommand).not.toContain(start);
    expect(shellCommand).not.toContain(selected);
    expect(shellCommand).not.toContain("eval");
  });

  it("uses only direct cd or zoxide navigation and rejects typed commands and control operators", async () => {
    const root = await temporaryDirectory();
    const child = join(root, "child");
    const bin = join(root, "bin");
    const script = join(root, "navigator.zsh");
    const zoxideArgs = join(root, "zoxide-args");
    await mkdir(child);
    await mkdir(bin);
    await writeFile(script, CWD_NAVIGATOR_ZSH_SCRIPT);
    const zoxide = join(bin, "zoxide");
    await writeFile(zoxide, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$CYBERDECK_ZOXIDE_ARGS\"",
      "printf '%s\\n' \"$CYBERDECK_ZOXIDE_RESULT\"",
    ].join("\n"));
    await chmod(zoxide, 0o700);

    const invoke = (line: string, cwd = child) => run("/bin/zsh", [
      "-fc",
      'source "$1"; builtin cd -- "$2"; cyberdeck_apply_navigation "$3" || exit $?; print -r -- "$PWD"',
      "cyberdeck-cwd-test",
      script,
      cwd,
      line,
    ], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CYBERDECK_ZOXIDE_ARGS: zoxideArgs,
        CYBERDECK_ZOXIDE_RESULT: child,
      },
    });

    const parentResult = await invoke("cd ..");
    expect(await realpath(parentResult.stdout.trim())).toBe(await realpath(root));
    const quotedResult = await invoke('cd "child"', root);
    expect(await realpath(quotedResult.stdout.trim())).toBe(await realpath(child));
    const previousResult = await run("/bin/zsh", [
      "-fc",
      'source "$1"; builtin cd -- "$2"; builtin cd -- "$3"; cyberdeck_apply_navigation "cd -" >/dev/null || exit $?; print -r -- "$PWD"',
      "cyberdeck-cwd-test",
      script,
      root,
      child,
    ]);
    expect(await realpath(previousResult.stdout.trim())).toBe(await realpath(root));
    const zoxideResult = await invoke("z cyb", root);
    expect(await realpath(zoxideResult.stdout.trim())).toBe(await realpath(child));
    expect((await readFile(zoxideArgs, "utf8")).split("\n").filter(Boolean)).toEqual(["query", "--", "cyb"]);
    await expect(invoke("rm -rf .")).rejects.toMatchObject({ code: 1 });
    await expect(invoke("cd .. && rm -rf .")).rejects.toMatchObject({ code: 1 });
    await expect(invoke("cd $(pwd)")).rejects.toMatchObject({ code: 1 });
  });

  it("fails clearly outside tmux or with an unsupported user shell", async () => {
    await expect(chooseWorkingDirectory("/tmp", {
      shell: "/bin/bash",
      insideTmux: true,
    })).rejects.toMatchObject({ code: "CWD_NAVIGATOR_UNSUPPORTED_SHELL" });
    await expect(chooseWorkingDirectory("/tmp", {
      shell: "/bin/zsh",
      insideTmux: false,
    })).rejects.toMatchObject({ code: "CWD_NAVIGATOR_REQUIRES_TMUX" });
  });

  it("confirms the current directory on empty Enter and leaves the channel empty on Ctrl-C", async () => {
    const root = await temporaryDirectory();
    const script = join(root, "navigator.zsh");
    await writeFile(script, CWD_NAVIGATOR_ZSH_SCRIPT);

    const runNavigator = async (input: string, resultName: string) => {
      const resultPath = join(root, resultName);
      await writeFile(resultPath, "");
      const terminal = pty.spawn("/bin/zsh", [
        "-fc",
        'source "$1"; builtin cd -- "$2"; cyberdeck_cwd_navigator "$3"',
        "cyberdeck-cwd-test",
        script,
        root,
        resultPath,
      ], {
        cwd: root,
        cols: 100,
        rows: 30,
        env: process.env as Record<string, string>,
      });
      let output = "";
      const prompt = new Promise<void>((resolve) => {
        terminal.onData((chunk) => {
          output += chunk;
          if (output.includes("cd> ")) resolve();
        });
      });
      const exited = new Promise<number>((resolve) => {
        terminal.onExit(({ exitCode }) => resolve(exitCode));
      });
      await prompt;
      terminal.write(input);
      return { exitCode: await exited, result: await readFile(resultPath, "utf8") };
    };

    await expect(runNavigator("\r", "confirmed")).resolves.toEqual({
      exitCode: 0,
      result: root,
    });
    await expect(runNavigator("\u0003", "cancelled")).resolves.toMatchObject({
      result: "",
    });
  });
});
