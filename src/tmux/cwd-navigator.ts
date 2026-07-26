import { spawnSync as nodeSpawnSync } from "node:child_process";
import { chmod, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

export type CwdNavigatorSpawnSync = (
  command: string,
  args: string[],
  options: { stdio: "inherit" },
) => { status: number | null; error?: Error };

export interface CwdNavigatorOptions {
  shell?: string | undefined;
  insideTmux?: boolean | undefined;
  spawnSync?: CwdNavigatorSpawnSync | undefined;
}

/**
 * This script is sourced only after zsh loads the user's normal interactive startup and completion
 * code. That startup/completion code is inside the user's trusted shell boundary. Text entered into
 * the navigator is not: it is tokenized only to recognize `cd` and `z`, and is never passed to eval,
 * `zsh -c`, or another general command runner.
 */
export const CWD_NAVIGATOR_ZSH_SCRIPT = String.raw`
function cyberdeck_navigation_error() {
  print -P "%F{red}$1%f" >&2
}

function cyberdeck_expand_home() {
  local value="$1"
  if [[ "$value" == "~" ]]; then
    REPLY="$HOME"
  elif [[ "$value" == "~/"* ]]; then
    REPLY="$HOME/\${value#\~/}"
  elif [[ "$value" == "~"* ]]; then
    cyberdeck_navigation_error "Only ~ and ~/ paths are supported"
    return 1
  else
    REPLY="$value"
  fi
}

function cyberdeck_apply_navigation() {
  emulate -L zsh
  setopt no_aliases
  local line="$1"

  # Reject every shell control surface before lexical splitting. Quoting does not turn commands,
  # substitutions, chains, pipes, redirects, or background jobs into allowed navigation.
  if [[ "$line" == *$'\n'* || "$line" == *[\;\|\&\<\>\`\$]* ]]; then
    cyberdeck_navigation_error "Only cd, z, ls, and pwd are allowed"
    return 1
  fi

  local -a words
  words=("\${(@Q)\${(z)line}}")
  (( \${#words} > 0 )) || return 0

  case "$words[1]" in
    cd)
      local target
      if (( \${#words} == 1 )); then
        target="$HOME"
      elif (( \${#words} == 2 )); then
        target="$words[2]"
      elif (( \${#words} == 3 )) && [[ "$words[2]" == "--" ]]; then
        target="$words[3]"
      else
        cyberdeck_navigation_error "Usage: cd [directory], cd .., cd -, or cd -- <directory>"
        return 1
      fi
      if [[ "$target" == "-" ]]; then
        builtin cd - || {
          cyberdeck_navigation_error "Previous directory is unavailable"
          return 1
        }
        return 0
      fi
      if [[ "$target" == -* ]]; then
        cyberdeck_navigation_error "Directory options are not supported"
        return 1
      fi
      cyberdeck_expand_home "$target" || return 1
      builtin cd -- "$REPLY" || {
        cyberdeck_navigation_error "Directory does not exist: $target"
        return 1
      }
      ;;
    z)
      if (( \${#words} < 2 )); then
        cyberdeck_navigation_error "Usage: z <terms>"
        return 1
      fi
      if ! whence -p zoxide >/dev/null; then
        cyberdeck_navigation_error "zoxide is not installed"
        return 1
      fi
      # Direct argv invocation is the only external command path. The leading -- prevents terms
      # from becoming zoxide options; the returned value is used only as a quoted cd operand.
      local target
      target="$(command zoxide query -- "\${words[@]:1}")" || {
        cyberdeck_navigation_error "No zoxide match"
        return 1
      }
      [[ -n "$target" ]] || {
        cyberdeck_navigation_error "No zoxide match"
        return 1
      }
      builtin cd -- "$target" || {
        cyberdeck_navigation_error "zoxide returned an unavailable directory"
        return 1
      }
      ;;
    ls)
      if (( \${#words} == 1 )); then
        command ls
      elif (( \${#words} == 2 )) && [[ "$words[2]" == "-a" || "$words[2]" == "-l" || "$words[2]" == "-la" || "$words[2]" == "-al" ]]; then
        command ls "$words[2]"
      else
        cyberdeck_navigation_error "Usage: ls, ls -a, ls -l, ls -la, or ls -al"
        return 1
      fi
      ;;
    pwd)
      if (( \${#words} != 1 )); then
        cyberdeck_navigation_error "Usage: pwd"
        return 1
      fi
      builtin pwd
      ;;
    *)
      cyberdeck_navigation_error "Only cd, z, ls, and pwd are allowed"
      return 1
      ;;
  esac
}

function cyberdeck_cwd_navigator() {
  emulate -L zsh
  setopt no_aliases
  local result_path="$1"
  local line

  print -P "%BChange working directory%b"
  print "Navigation: cd <dir>, cd .., cd -, z <terms> · inspect: ls [-a|-l|-la|-al], pwd"
  print "Tab uses your zsh completion · empty Enter confirms · Ctrl-C cancels"
  print

  while true; do
    print -P "%F{blue}$PWD%f"
    line=""
    vared -p "cd> " -c line || return 130
    if [[ -z "\${line//[[:space:]]/}" ]]; then
      print -rn -- "$PWD" >| "$result_path"
      return 0
    fi
    cyberdeck_apply_navigation "$line"
  done
}
`.replaceAll("\\${", "${");

export async function chooseWorkingDirectory(
  startCwd: string,
  options: CwdNavigatorOptions = {},
): Promise<string | undefined> {
  const shell = options.shell ?? process.env.SHELL;
  if (shell === undefined || !isAbsolute(shell) || basename(shell) !== "zsh") {
    throw navigatorError(
      "CWD_NAVIGATOR_UNSUPPORTED_SHELL",
      `Cyberdeck's directory navigator currently requires zsh as the user's absolute SHELL; received ${shell ?? "unset"}`,
    );
  }
  if (!(options.insideTmux ?? Boolean(process.env.TMUX))) {
    throw navigatorError(
      "CWD_NAVIGATOR_REQUIRES_TMUX",
      "Cyberdeck's directory navigator requires Fleet to be running inside tmux",
    );
  }

  const canonicalStart = await requireDirectory(startCwd, "CWD_NAVIGATOR_INVALID_START");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "cyberdeck-cwd-navigator-"));
  await chmod(temporaryDirectory, 0o700);
  const scriptPath = join(temporaryDirectory, "navigator.zsh");
  const resultPath = join(temporaryDirectory, "selected-cwd");

  try {
    await writeFile(scriptPath, CWD_NAVIGATOR_ZSH_SCRIPT, { encoding: "utf8", mode: 0o600 });
    const resultHandle = await open(resultPath, "wx", 0o600);
    await resultHandle.close();

    const spawnSync = options.spawnSync ?? (nodeSpawnSync as CwdNavigatorSpawnSync);
    const result = spawnSync("tmux", [
      "display-popup",
      "-E",
      "-d",
      canonicalStart,
      "-w",
      "80%",
      "-h",
      "60%",
      "-T",
      "Cyberdeck · Change directory",
      shell,
      "-lic",
      'source "$1"; [[ "$PWD" == "$2" ]] || builtin cd -- "$2" || exit 72; cyberdeck_cwd_navigator "$3"',
      "cyberdeck-cwd-navigator",
      scriptPath,
      canonicalStart,
      resultPath,
    ], { stdio: "inherit" });

    const selected = await readFile(resultPath, "utf8");
    if (selected === "") {
      if (result.error !== undefined) throw result.error;
      if (result.status === 0 || result.status === 130) return undefined;
      throw navigatorError(
        "CWD_NAVIGATOR_FAILED",
        `tmux directory navigator exited with status ${result.status ?? "unknown"}`,
      );
    }
    return requireDirectory(selected, "CWD_NAVIGATOR_INVALID_RESULT");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function requireDirectory(path: string, code: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw navigatorError(code, `Working directory must be absolute: ${path}`);
  }
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw navigatorError(code, `Working directory is not an accessible directory: ${path}`);
  }
  return canonical;
}

function navigatorError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
