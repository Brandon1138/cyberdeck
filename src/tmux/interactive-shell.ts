import { spawnSync as nodeSpawnSync } from "node:child_process";
import { chmod, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

export type InteractiveShellSpawnSync = (
  command: string,
  args: string[],
  options: { stdio: "inherit" },
) => { status: number | null; error?: Error };

export interface InteractiveShellOptions {
  shell?: string | undefined;
  insideTmux?: boolean | undefined;
  spawnSync?: InteractiveShellSpawnSync | undefined;
  /** The operator's real `ZDOTDIR`, when they have one. */
  zdotdir?: string | undefined;
  home?: string | undefined;
}

/**
 * Installed as the popup shell's `.zshenv`, and only for the duration of the popup.
 *
 * `.zshenv` is the one startup file zsh always reads, and it is read before `.zprofile`, `.zshrc`
 * and `.zlogin`. Restoring `ZDOTDIR` to the operator's own value on the first line therefore means
 * zsh looks up every later startup file exactly where it normally would: this file is a prologue to
 * the operator's shell, not a replacement for it. Only `.zshenv` itself has to be sourced by hand,
 * because ours was read in its place.
 *
 * The cwd is recorded on `chpwd` as well as on `zshexit` so a popup that is killed rather than
 * exited still hands back the last directory the operator moved to.
 */
export const INTERACTIVE_SHELL_ZSHENV = String.raw`
ZDOTDIR="\${CYBERDECK_SHELL_ZDOTDIR:-$HOME}"
if [[ -n "$CYBERDECK_SHELL_CWD" ]]; then
  function cyberdeck_record_shell_cwd() {
    printf '%s' "$PWD" >| "$CYBERDECK_SHELL_CWD"
  }
  autoload -Uz add-zsh-hook 2>/dev/null && {
    add-zsh-hook zshexit cyberdeck_record_shell_cwd
    add-zsh-hook chpwd cyberdeck_record_shell_cwd
  } || true
fi
[[ -r "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
return 0
`.replaceAll("\\${", "${");

/**
 * GNU Bash login shells ignore --rcfile. Enter through ENV during startup, restore normal Bash
 * mode, source the usual login files once, then install the exit hook. PROMPT_COMMAND and native
 * history/Readline initialization are left to Bash. No user startup file is changed.
 */
export const INTERACTIVE_SHELL_BASH_INIT = String.raw`
# Enter through GNU Bash's POSIX ENV startup path, then restore normal Bash before loading
# the real login files. This is still startup: history and Readline initialize afterwards.
builtin set +o posix
case ":$CYBERDECK_SHELL_BASH_OPTIONS:" in
  *:inherit_errexit:*) builtin shopt -s inherit_errexit 2>/dev/null || builtin true ;;
  *) builtin shopt -u inherit_errexit 2>/dev/null || builtin true ;;
esac
case ":$CYBERDECK_SHELL_BASH_OPTIONS:" in
  *:shift_verbose:*) builtin shopt -s shift_verbose ;;
  *) builtin shopt -u shift_verbose ;;
esac
if [[ "$CYBERDECK_SHELL_ENV_SET" == 1 ]]; then
  builtin export ENV="$CYBERDECK_SHELL_ENV"
else
  builtin unset ENV
fi
builtin unset CYBERDECK_SHELL_BASH_OPTIONS CYBERDECK_SHELL_ENV_SET CYBERDECK_SHELL_ENV
if [[ -r /etc/profile ]]; then
  builtin source /etc/profile
fi
for cyberdeck_shell_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [[ -r "$cyberdeck_shell_profile" && ! -d "$cyberdeck_shell_profile" ]]; then
    builtin source -- "$cyberdeck_shell_profile"
    break
  fi
done
builtin unset cyberdeck_shell_profile CYBERDECK_SHELL_BASH_INIT

cyberdeck_record_shell_cwd() {
  builtin local cyberdeck_shell_status=$?
  builtin printf '%s' "$PWD" >| "$CYBERDECK_SHELL_CWD" || builtin true
  builtin return "$cyberdeck_shell_status"
}
cyberdeck_shell_exit_command=$(builtin trap -p EXIT)
if [[ -n "$cyberdeck_shell_exit_command" ]]; then
  cyberdeck_shell_exit_command=\${cyberdeck_shell_exit_command#trap -- }
  cyberdeck_shell_exit_command=\${cyberdeck_shell_exit_command% EXIT}
  # trap -p supplies shell-quoted text, including quotes and newlines in the user's handler.
  builtin eval -- "cyberdeck_shell_exit_command=$cyberdeck_shell_exit_command"
fi
# Both branches enter the user's handler with its original $?; the condition also prevents
# errexit from skipping that handler when the shell exits with a nonzero status.
builtin trap -- 'if cyberdeck_record_shell_cwd; then
  builtin eval -- "$cyberdeck_shell_exit_command"
else
  builtin eval -- "$cyberdeck_shell_exit_command"
fi' EXIT
`.replaceAll("\\${", "${");

/** Only an exec launcher: Bash owns the popup's terminal and interactive input loop. */
export const INTERACTIVE_SHELL_BASH_LAUNCH = String.raw`
const { spawnSync } = require("node:child_process");
const shell = process.argv[1];
const environment = { ...process.env };
const probe = spawnSync(shell, ["--noprofile", "--norc", "-c", "(( BASH_VERSINFO[0] >= 4 ))"], {
  env: { ...environment, BASH_ENV: "/dev/null" }, stdio: "ignore", timeout: 3000,
});
const posix = Object.hasOwn(environment, "POSIXLY_CORRECT")
  || (environment.SHELLOPTS ?? "").split(":").includes("posix");
let args = [shell, "-li"];
// Apple Bash 3.2 ignores POSIX ENV startup. Preserve its existing popup, and the operator's
// explicitly selected POSIX startup rules, rather than replaying profiles after startup.
if (probe.status === 0 && !posix) {
  environment.CYBERDECK_SHELL_BASH_OPTIONS = environment.BASHOPTS ?? "";
  environment.CYBERDECK_SHELL_ENV_SET = Object.hasOwn(environment, "ENV") ? "1" : "0";
  environment.CYBERDECK_SHELL_ENV = environment.ENV ?? "";
  // ENV expands this fixed expression once; quotes/newlines/$(...) in the path remain data.
  environment.ENV = "$CYBERDECK_SHELL_BASH_INIT";
  args = [shell, "--posix", "-li"];
}
process.execve(shell, args, environment);
`;

/**
 * Opens the operator's login shell, interactively, in a tmux popup, and reports where they left it.
 *
 * There is no allowlist and no wrapper REPL: this is `$SHELL -li` with the operator's own rc files,
 * completion, aliases and functions, which is what makes it the escape hatch for everything Fleet's
 * non-interactive `!` mode cannot host — `vim`, `less`, `fzf`, `gh auth login`.
 *
 * The cwd handoff uses shell startup/exit hooks rather than anything tmux knows. A popup is not a
 * pane: it appears in no `list-panes`, and `#{pane_current_path}` inside one reports the *launching*
 * pane's directory, so there is nothing for tmux to read back. A shell other than zsh or Bash gets
 * its popup; it just hands nothing back, and Fleet's cwd stays where it was.
 */
export async function openInteractiveShell(
  startCwd: string,
  options: InteractiveShellOptions = {},
): Promise<string | undefined> {
  const shell = options.shell ?? process.env.SHELL;
  if (shell === undefined || !isAbsolute(shell)) {
    throw shellError(
      "INTERACTIVE_SHELL_UNSUPPORTED_SHELL",
      `Cyberdeck's shell popup requires an absolute SHELL; received ${shell ?? "unset"}`,
    );
  }
  if (!(options.insideTmux ?? Boolean(process.env.TMUX))) {
    throw shellError(
      "INTERACTIVE_SHELL_REQUIRES_TMUX",
      "Cyberdeck's shell popup requires Fleet to be running inside tmux",
    );
  }

  const canonicalStart = await requireDirectory(startCwd, "INTERACTIVE_SHELL_INVALID_START");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cyberdeck-shell-"));
  await chmod(temporaryDirectory, 0o700);
  const resultPath = join(temporaryDirectory, "final-cwd");
  const shellName = basename(shell);

  try {
    const resultHandle = await open(resultPath, "wx", 0o600);
    await resultHandle.close();
    // The popup runs under the tmux *server's* environment, not this process's, so everything the
    // startup file needs is handed over as an explicit `-e` rather than exported here.
    const environment: string[] = [];
    let shellArguments = [shell, "-li"];
    if (shellName === "zsh") {
      await writeFile(join(temporaryDirectory, ".zshenv"), INTERACTIVE_SHELL_ZSHENV, {
        encoding: "utf8",
        mode: 0o600,
      });
      environment.push("-e", `ZDOTDIR=${temporaryDirectory}`);
      environment.push("-e", `CYBERDECK_SHELL_CWD=${resultPath}`);
      const zdotdir = options.zdotdir ?? process.env.ZDOTDIR ?? options.home ?? homedir();
      environment.push("-e", `CYBERDECK_SHELL_ZDOTDIR=${zdotdir}`);
    } else if (shellName === "bash") {
      const initPath = join(temporaryDirectory, "bash-init");
      await writeFile(initPath, INTERACTIVE_SHELL_BASH_INIT, { encoding: "utf8", mode: 0o600 });
      environment.push("-e", `CYBERDECK_SHELL_CWD=${resultPath}`);
      environment.push("-e", `CYBERDECK_SHELL_BASH_INIT=${initPath}`);
      // Shell and hook paths travel as argv/environment data, never interpolated shell code.
      shellArguments = [process.execPath, "--input-type=commonjs", "-e", INTERACTIVE_SHELL_BASH_LAUNCH, shell];
    }

    const spawnSync = options.spawnSync ?? (nodeSpawnSync as InteractiveShellSpawnSync);
    // A non-zero status is the operator's last command, not a fault of ours: `exit` with no
    // argument carries it out of the shell. Only a spawn that never happened is an error here.
    const result = spawnSync("tmux", [
      "display-popup",
      "-E",
      "-d",
      canonicalStart,
      "-w",
      "90%",
      "-h",
      "85%",
      // The title carries the way out. While the popup is up, Fleet's process is parked in this
      // very call and tmux is routing the keyboard into the popup's pane, so no Fleet binding can
      // reach Fleet to close it — the exit is the shell's own `exit`, and the title is the only
      // surface that can say so.
      "-T",
      "Cyberdeck · shell · ctrl+d or exit to close",
      ...environment,
      ...shellArguments,
    ], { stdio: "inherit" });
    if (result.error !== undefined) throw result.error;

    const selected = await readFile(resultPath, "utf8");
    if (selected === "") return undefined;
    return requireDirectory(selected, "INTERACTIVE_SHELL_INVALID_RESULT");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function requireDirectory(path: string, code: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw shellError(code, `Working directory must be absolute: ${path}`);
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw shellError(code, `Working directory is not an accessible directory: ${path}`);
  }
  return canonical;
}

function shellError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
