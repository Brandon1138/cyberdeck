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
 * Opens the operator's login shell, interactively, in a tmux popup, and reports where they left it.
 *
 * There is no allowlist and no wrapper REPL: this is `$SHELL -li` with the operator's own rc files,
 * completion, aliases and functions, which is what makes it the escape hatch for everything Fleet's
 * non-interactive `!` mode cannot host — `vim`, `less`, `fzf`, `gh auth login`.
 *
 * The cwd handoff is a zsh startup-file hook rather than anything tmux knows. A popup is not a
 * pane: it appears in no `list-panes`, and `#{pane_current_path}` inside one reports the *launching*
 * pane's directory, so there is nothing for tmux to read back. A shell that is not zsh still gets
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
  const capturesCwd = basename(shell) === "zsh";

  try {
    const resultHandle = await open(resultPath, "wx", 0o600);
    await resultHandle.close();
    // The popup runs under the tmux *server's* environment, not this process's, so everything the
    // startup file needs is handed over as an explicit `-e` rather than exported here.
    const environment: string[] = [];
    if (capturesCwd) {
      await writeFile(join(temporaryDirectory, ".zshenv"), INTERACTIVE_SHELL_ZSHENV, {
        encoding: "utf8",
        mode: 0o600,
      });
      environment.push("-e", `ZDOTDIR=${temporaryDirectory}`);
      environment.push("-e", `CYBERDECK_SHELL_CWD=${resultPath}`);
      const zdotdir = options.zdotdir ?? process.env.ZDOTDIR ?? options.home ?? homedir();
      environment.push("-e", `CYBERDECK_SHELL_ZDOTDIR=${zdotdir}`);
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
      shell,
      "-li",
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
