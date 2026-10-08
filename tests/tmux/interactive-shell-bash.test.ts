import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERACTIVE_SHELL_BASH_INIT,
  INTERACTIVE_SHELL_BASH_LAUNCH,
  openInteractiveShell,
} from "../../src/tmux/interactive-shell.js";

const directories: string[] = [];
const bash = process.env.CYBERDECK_TEST_BASH ?? "/bin/bash";
const version = spawnSync(bash, ["-c", 'printf "%s.%s" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], {
  encoding: "utf8",
});
const [major = 0, minor = 0] = version.stdout?.split(".").map(Number) ?? [];
const arrayPrompts = major > 5 || (major === 5 && minor >= 1);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cyberdeck-bash-test-")));
  directories.push(root);
  const home = join(root, "home 'quotes' $(touch injected)\nline");
  const selected = join(root, "selected 'quotes' $(touch injected)\ntrailing\n");
  await mkdir(home);
  await mkdir(selected);
  return { root, home, selected };
}

async function popup(
  paths: Awaited<ReturnType<typeof fixture>>,
  input: string,
  environment: Record<string, string> = {},
  shell = bash,
) {
  let status: number | null = null;
  let stdout = "";
  let stderr = "";
  let handoff = "";
  const selected = await openInteractiveShell(paths.root, {
    shell,
    insideTmux: true,
    spawnSync(command, args) {
      expect(command).toBe("tmux");
      expect(args.slice(-5)).toEqual([
        process.execPath, "--input-type=commonjs", "-e", INTERACTIVE_SHELL_BASH_LAUNCH, shell,
      ]);
      expect(args).not.toContain("list-panes");
      expect(args.join(" ")).not.toContain("pane_current_path");
      const popupEnvironment: Record<string, string> = {};
      args.slice(0, -5).forEach((argument, index) => {
        if (argument !== "-e") return;
        const assignment = args[index + 1]!;
        const split = assignment.indexOf("=");
        popupEnvironment[assignment.slice(0, split)] = assignment.slice(split + 1);
      });
      handoff = popupEnvironment.CYBERDECK_SHELL_CWD!;
      const child = spawnSync(process.execPath, args.slice(-4), {
        cwd: paths.root,
        env: {
          ...process.env,
          HOME: paths.home,
          TERM: "dumb",
          CYBERDECK_TEST_SELECTED: paths.selected,
          CYBERDECK_TEST_ROOT: paths.root,
          ...popupEnvironment,
          ...environment,
        },
        input,
        encoding: "utf8",
        timeout: 5_000,
      });
      status = child.status;
      stdout = child.stdout ?? "";
      stderr = child.stderr ?? "";
      return { status: child.status, ...(child.error ? { error: child.error } : {}) };
    },
  });
  expect(existsSync(dirname(handoff))).toBe(false);
  return { selected, status, stdout, stderr };
}

describe.skipIf(version.error !== undefined || major < 4)("GNU Bash popup cwd handoff", () => {
  it("matches native Bash's first prompt status and immediate bare exit after a failing profile", async () => {
    const paths = await fixture();
    const prompts = join(paths.root, "prompts");
    await writeFile(join(paths.home, ".bash_profile"), String.raw`
PROMPT_COMMAND='printf "%s\n" "$?" >> "$CYBERDECK_TEST_ROOT/prompts"'
false
`);
    const native = spawnSync(bash, ["-li"], {
      cwd: paths.root,
      env: { ...process.env, HOME: paths.home, TERM: "dumb", CYBERDECK_TEST_ROOT: paths.root },
      input: "exit\n", encoding: "utf8", timeout: 5_000,
    });
    expect(native.error).toBeUndefined();
    expect(native.status).toBe(1);
    const nativePrompts = await readFile(prompts, "utf8");
    expect(nativePrompts).toBe("1\n");
    await writeFile(prompts, "");
    const result = await popup(paths, "exit\n");
    expect(result.status).toBe(native.status);
    expect(await readFile(prompts, "utf8")).toBe(nativePrompts);
    expect(result.selected).toBe(paths.root);
  });

  it("loads the real login files once, preserves aliases, and captures direct exit with quoted/newline paths", async () => {
    const paths = await fixture();
    await writeFile(join(paths.home, ".bash_profile"), String.raw`
printf 'profile\n' >> "$CYBERDECK_TEST_ROOT/startup"
source "$HOME/.bashrc"
`);
    await writeFile(join(paths.home, ".bashrc"), String.raw`
printf 'bashrc\n' >> "$CYBERDECK_TEST_ROOT/startup"
alias chosen='builtin cd -- "$CYBERDECK_TEST_SELECTED"'
PROMPT_COMMAND='printf "prompt\n" >> "$CYBERDECK_TEST_ROOT/prompts"'
trap 'printf "%s" "$?" > "$CYBERDECK_TEST_ROOT/exit-status"' EXIT
`);
    await writeFile(join(paths.home, ".bash_login"), 'printf wrong > "$CYBERDECK_TEST_ROOT/wrong"\n');
    await writeFile(join(paths.home, ".profile"), 'printf wrong > "$CYBERDECK_TEST_ROOT/wrong"\n');
    await writeFile(join(paths.home, ".bash_logout"), 'printf logout > "$CYBERDECK_TEST_ROOT/logout"\n');
    const result = await popup(paths, 'shopt login_shell; printf "flags=%s\\n" "$-"\nchosen; exit 7\n');
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(7);
    expect(result.stdout).toMatch(/login_shell\s+on/u);
    expect(result.stdout).toMatch(/flags=\S*i\S*/u);
    expect(await readFile(join(paths.root, "startup"), "utf8")).toBe("profile\nbashrc\n");
    expect(await readFile(join(paths.root, "prompts"), "utf8")).toBe("prompt\nprompt\n");
    expect(await readFile(join(paths.root, "exit-status"), "utf8")).toBe("7");
    expect(await readFile(join(paths.root, "logout"), "utf8")).toBe("logout");
    expect(existsSync(join(paths.root, "wrong"))).toBe(false);
    expect(existsSync(join(paths.root, "injected"))).toBe(false);
  });

  it.each([".bash_login", ".profile"])("uses %s when earlier login files are absent", async (profile) => {
    const paths = await fixture();
    await writeFile(join(paths.home, profile), 'alias chosen=\'builtin cd -- "$CYBERDECK_TEST_SELECTED"\'\n');
    const result = await popup(paths, "chosen\nexit\n");
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(0);
  });

  it("preserves a readonly string PROMPT_COMMAND, its status, and bare exit after failure", async () => {
    const paths = await fixture();
    await writeFile(join(paths.home, ".bash_profile"), String.raw`
PROMPT_COMMAND='printf "%s\n" "$?" >> "$CYBERDECK_TEST_ROOT/prompts"'
readonly PROMPT_COMMAND
trap 'printf "%s" "$?" > "$CYBERDECK_TEST_ROOT/exit-status"' EXIT
`);
    const result = await popup(paths, 'builtin cd -- "$CYBERDECK_TEST_SELECTED"\nfalse\nexit\n');
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(1);
    expect(await readFile(join(paths.root, "prompts"), "utf8")).toBe("0\n0\n1\n");
    expect(await readFile(join(paths.root, "exit-status"), "utf8")).toBe("1");
    expect(result.stderr).not.toContain("readonly");
  });

  it("preserves indexed array PROMPT_COMMAND and native Bash version behavior", async () => {
    const paths = await fixture();
    await writeFile(join(paths.home, ".bash_profile"), String.raw`
PROMPT_COMMAND=('printf "first\n" >> "$CYBERDECK_TEST_ROOT/prompts"' 'printf "second\n" >> "$CYBERDECK_TEST_ROOT/prompts"')
readonly -a PROMPT_COMMAND
`);
    const result = await popup(paths, 'builtin cd -- "$CYBERDECK_TEST_SELECTED"\nexit\n');
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(0);
    expect(await readFile(join(paths.root, "prompts"), "utf8"))
      .toBe(arrayPrompts ? "first\nsecond\nfirst\nsecond\n" : "first\nfirst\n");
  });

  it("keeps an inherited PROMPT_COMMAND when login files leave it unchanged", async () => {
    const paths = await fixture();
    const result = await popup(paths, 'builtin cd -- "$CYBERDECK_TEST_SELECTED"\nexit\n', {
      PROMPT_COMMAND: 'printf "inherited\\n" >> "$CYBERDECK_TEST_ROOT/prompts"',
    });
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(0);
    expect(await readFile(join(paths.root, "prompts"), "utf8")).toBe("inherited\ninherited\n");
  });

  it.each([{}, { BASHOPTS: "inherit_errexit:shift_verbose", SHELLOPTS: "errtrace:functrace" }])(
    "restores native shell options and the original ENV before login files", async (settings) => {
      const paths = await fixture();
      const native = await fixture();
      const environment = { ...settings, ENV: "$(touch injected_env)" };
      for (const current of [paths, native]) {
        await writeFile(join(current.home, ".bash_profile"), String.raw`
shopt -p > "$CYBERDECK_TEST_ROOT/options"
printf '%s' "$SHELLOPTS" > "$CYBERDECK_TEST_ROOT/shell-options"
printf '%s' "$ENV" > "$CYBERDECK_TEST_ROOT/original-env"
`);
      }
      const input = 'builtin cd -- "$CYBERDECK_TEST_SELECTED"; exit\n';
      const baseline = spawnSync(bash, ["-li"], {
        cwd: native.root, input, encoding: "utf8", timeout: 5_000,
        env: { ...process.env, HOME: native.home, TERM: "dumb", ...environment,
          CYBERDECK_TEST_ROOT: native.root, CYBERDECK_TEST_SELECTED: native.selected },
      });
      const result = await popup(paths, input, environment);
      expect(result.selected).toBe(paths.selected);
      expect(result.status).toBe(baseline.status);
      for (const file of ["options", "shell-options", "original-env"]) {
        expect(await readFile(join(paths.root, file), "utf8"))
          .toBe(await readFile(join(native.root, file), "utf8"));
      }
      expect(existsSync(join(paths.root, "injected_env"))).toBe(false);
    },
  );

  it("treats quotes, command substitutions, and newlines in the bootstrap path as data", async () => {
    const paths = await fixture();
    const initPath = join(paths.root, "init 'quotes' $(touch injected)\ntrailing\n");
    await writeFile(initPath, INTERACTIVE_SHELL_BASH_INIT, { mode: 0o600 });
    const result = await popup(paths, 'builtin cd -- "$CYBERDECK_TEST_SELECTED"; exit\n', {
      CYBERDECK_SHELL_BASH_INIT: initPath,
    });
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(0);
    expect(existsSync(join(paths.root, "injected"))).toBe(false);
  });

  it("preserves explicitly selected POSIX startup with the existing no-handoff behavior", async () => {
    const paths = await fixture();
    const envPath = join(paths.home, "env startup");
    await writeFile(envPath, String.raw`
printf 'env\n' >> "$CYBERDECK_TEST_ROOT/startup"
alias chosen='builtin cd -- "$CYBERDECK_TEST_SELECTED"'
`);
    await writeFile(join(paths.home, ".bash_profile"), "exit 73\n");
    const result = await popup(paths, "chosen; exit 19\n", {
      POSIXLY_CORRECT: "1", ENV: "$CYBERDECK_TEST_ENV_PATH", CYBERDECK_TEST_ENV_PATH: envPath,
    });
    expect(result.selected).toBeUndefined();
    expect(result.status).toBe(19);
    expect(await readFile(join(paths.root, "startup"), "utf8")).toBe("env\n");
    expect(existsSync(join(paths.root, "injected"))).toBe(false);
  });

  it.each([
    "", "history -s startup-entry", 'history -r "$HOME/other history"',
    "history -s startup-entry; history -c", 'history -s startup-entry; history -a "$HISTFILE"',
  ])("matches native login history initialization and file writes: %s", async (operation) => {
    const paths = await fixture();
    const native = await fixture();
    for (const current of [paths, native]) {
      await writeFile(join(current.home, ".bash_history"), "default-history\n");
      await writeFile(join(current.home, "custom history"), "custom-history\n");
      await writeFile(join(current.home, "other history"), "other-history\n");
      await writeFile(join(current.home, ".bash_profile"), String.raw`
history > "$CYBERDECK_TEST_ROOT/history-before-profile"
HISTFILE="$HOME/custom history"
HISTCONTROL=ignorespace
shopt -s histappend
trap 'printf "%s\n" "$?" >> "$CYBERDECK_TEST_ROOT/exit-status"' EXIT
` + operation + "\n");
    }
    const input = ' history > "$CYBERDECK_TEST_ROOT/loaded-history"\n builtin cd -- "$CYBERDECK_TEST_SELECTED"\n';
    const baseline = spawnSync(bash, ["-li"], {
      cwd: native.root,
      env: { ...process.env, HOME: native.home, TERM: "dumb",
        CYBERDECK_TEST_ROOT: native.root, CYBERDECK_TEST_SELECTED: native.selected },
      input, encoding: "utf8", timeout: 5_000,
    });
    expect(baseline.error).toBeUndefined();
    const result = await popup(paths, input);
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(baseline.status);
    for (const file of ["history-before-profile", "loaded-history", "exit-status"]) {
      expect(await readFile(join(paths.root, file), "utf8"))
        .toBe(await readFile(join(native.root, file), "utf8"));
    }
    for (const file of [".bash_history", "custom history", "other history"]) {
      expect(await readFile(join(paths.home, file), "utf8"))
        .toBe(await readFile(join(native.home, file), "utf8"));
    }
  });

  it.each(["set +o history", "unset HISTFILE"])("honors history startup setting: %s", async (setting) => {
    const paths = await fixture();
    await writeFile(join(paths.home, ".bash_history"), "saved-history\n");
    await writeFile(join(paths.home, ".bash_profile"), `${setting}\nHISTCONTROL=ignorespace\n`);
    const result = await popup(paths, ' history > "$CYBERDECK_TEST_ROOT/loaded-history"\n builtin cd -- "$CYBERDECK_TEST_SELECTED"\n');
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(0);
    expect(await readFile(join(paths.root, "loaded-history"), "utf8")).toBe("");
    expect(await readFile(join(paths.home, ".bash_history"), "utf8")).toBe("saved-history\n");
  });

  it.each(["exit 9\n", ""])("captures cwd on explicit exit or EOF, preserving trap's explicit exit", async (ending) => {
    const paths = await fixture();
    await writeFile(join(paths.home, ".bash_profile"), String.raw`
trap 'printf "status=%s\n" "$?" > "$CYBERDECK_TEST_ROOT/exit-status"; exit 23' EXIT
`);
    const result = await popup(paths, `builtin cd -- "$CYBERDECK_TEST_SELECTED"\n${ending}`);
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(23);
    expect(await readFile(join(paths.root, "exit-status"), "utf8"))
      .toBe(ending ? "status=9\n" : "status=0\n");
  });

  it("captures cwd and retains the user's EXIT trap under errexit", async () => {
    const paths = await fixture();
    await writeFile(join(paths.home, ".bash_profile"), String.raw`
set -e
trap 'printf "%s" "$?" > "$CYBERDECK_TEST_ROOT/exit-status"' EXIT
`);
    const result = await popup(paths, 'builtin cd -- "$CYBERDECK_TEST_SELECTED"\nfalse\n');
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(1);
    expect(await readFile(join(paths.root, "exit-status"), "utf8")).toBe("1");
  });

  it("preserves multiline quoted EXIT handlers and functions, including a failing final trap command", async () => {
    const paths = await fixture();
    const handler = `printf '%s' "$?" > "$CYBERDECK_TEST_ROOT/exit-status"
printf '%s' "single quote: ' and newline
end" > "$CYBERDECK_TEST_ROOT/trap-content"
false`;
    const quoted = "'" + handler.replaceAll("'", "'\\''") + "'";
    await writeFile(join(paths.home, ".bash_profile"), String.raw`
printf() {
  builtin printf 'user\n' >> "$CYBERDECK_TEST_ROOT/printf-calls"
  builtin printf "$@"
}
` + `trap -- ${quoted} EXIT\n`);
    const result = await popup(paths, 'builtin cd -- "$CYBERDECK_TEST_SELECTED"; exit 7\n');
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(7);
    expect(await readFile(join(paths.root, "exit-status"), "utf8")).toBe("7");
    expect(await readFile(join(paths.root, "trap-content"), "utf8")).toBe("single quote: ' and newline\nend");
    expect(await readFile(join(paths.root, "printf-calls"), "utf8")).toBe("user\nuser\n");
  });

  it("passes a shell path containing shell syntax as argv data", async () => {
    const paths = await fixture();
    const executableDirectory = join(paths.root, "shell 'quotes' $(touch injected)\nline");
    await mkdir(executableDirectory);
    const executable = join(executableDirectory, "bash");
    await symlink(bash, executable);
    const result = await popup(paths, 'builtin cd -- "$CYBERDECK_TEST_SELECTED"; exit\n', {}, executable);
    expect(result.selected).toBe(paths.selected);
    expect(result.status).toBe(0);
    expect(existsSync(join(paths.root, "injected"))).toBe(false);
  });

  it("keeps hook files private and removes them on a spawn failure", async () => {
    const paths = await fixture();
    let initPath = "";
    const failure = new Error("disposable spawn failure");
    await expect(openInteractiveShell(paths.root, {
      shell: bash,
      insideTmux: true,
      spawnSync(_command, args) {
        const assignment = args.find((argument) => argument.startsWith("CYBERDECK_SHELL_BASH_INIT="))!;
        initPath = assignment.slice(assignment.indexOf("=") + 1);
        expect(statSync(dirname(initPath)).mode & 0o777).toBe(0o700);
        expect(statSync(initPath).mode & 0o777).toBe(0o600);
        expect(statSync(join(dirname(initPath), "final-cwd")).mode & 0o777).toBe(0o600);
        return { status: null, error: failure };
      },
    })).rejects.toBe(failure);
    expect(existsSync(dirname(initPath))).toBe(false);
    const firstInitPath = initPath;
    // A later popup creates fresh hooks rather than reusing any previous shell's state.
    await openInteractiveShell(paths.root, {
      shell: bash,
      insideTmux: true,
      spawnSync(_command, args) {
        initPath = args.find((argument) => argument.startsWith("CYBERDECK_SHELL_BASH_INIT="))!
          .slice("CYBERDECK_SHELL_BASH_INIT=".length);
        return { status: 0 };
      },
    });
    expect(initPath).not.toBe(firstInitPath);
    await expect(stat(initPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const legacyVersion = spawnSync("/bin/bash", ["-c", 'printf "%s" "${BASH_VERSINFO[0]}"'], { encoding: "utf8" });
it.skipIf(legacyVersion.error !== undefined || Number(legacyVersion.stdout) >= 4)(
  "preserves legacy Bash startup, aliases, prompt commands, and exit traps without cwd handoff", async () => {
    const paths = await fixture();
    await writeFile(join(paths.home, ".bash_profile"), String.raw`
printf 'startup\n' >> "$CYBERDECK_TEST_ROOT/startup"
alias chosen='builtin cd -- "$CYBERDECK_TEST_SELECTED"'
PROMPT_COMMAND='printf "prompt\n" >> "$CYBERDECK_TEST_ROOT/prompts"'
readonly PROMPT_COMMAND
trap 'printf "%s" "$?" > "$CYBERDECK_TEST_ROOT/exit-status"' EXIT
`);
    const result = await popup(paths, "chosen; exit 7\n", {}, "/bin/bash");
    expect(result.selected).toBeUndefined();
    expect(result.status).toBe(7);
    expect(await readFile(join(paths.root, "startup"), "utf8")).toBe("startup\n");
    expect(await readFile(join(paths.root, "prompts"), "utf8")).toBe("prompt\n");
    expect(await readFile(join(paths.root, "exit-status"), "utf8")).toBe("7");
  },
);
