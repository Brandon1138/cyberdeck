import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openInteractiveShell } from "../../src/tmux/interactive-shell.js";

const directories: string[] = [];
const pythonAvailable = spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
const bash = process.env.CYBERDECK_TEST_BASH ?? "/bin/bash";
const bashVersion = spawnSync(bash, ["-c", 'printf "%s" "${BASH_VERSINFO[0]}"'], { encoding: "utf8" });
const bashCapturesCwd = Number(bashVersion.stdout) >= 4;

// A fresh controlling terminal, not a pipe or any existing tmux/provider session. The child is
// ours alone; timeout cleanup addresses only its PID. Real popup/server proof is a separate gate.
const PTY_DRIVER = String.raw`
import errno, json, os, pty, select, signal, sys, time
case = json.loads(sys.argv[1])
pid, terminal = pty.fork()
if pid == 0:
    os.chdir(case["cwd"])
    os.execvpe(case["command"][0], case["command"], case["environment"])
deadline = time.monotonic() + 5
transcript = bytearray()
pending = bytearray()
waited = False

def receive():
    if time.monotonic() >= deadline:
        raise TimeoutError("disposable shell PTY timed out")
    if select.select([terminal], [], [], 0.05)[0]:
        try:
            data = os.read(terminal, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            data = b""
        transcript.extend(data)
        pending.extend(data)
        return bool(data)
    return True

def prompt():
    marker = b"CYBERDECK_PTY_READY> "
    while marker not in pending:
        if not receive():
            raise RuntimeError("shell exited before its prompt")
    end = pending.index(marker) + len(marker)
    del pending[:end]

try:
    prompt()
    os.write(terminal, b"if [[ -t 0 && -t 1 ]]; then printf 'CYBERDECK_PTY_OK\\n'; fi\r")
    prompt()
    os.write(terminal, b"chosen\r")
    prompt()
    os.write(terminal, b"\x04" if case["eof"] else b"exit 11\r")
    while True:
        receive()
        ended, status = os.waitpid(pid, os.WNOHANG)
        if ended:
            waited = True
            print(json.dumps({"status": os.waitstatus_to_exitcode(status),
                              "transcript": transcript.decode("utf-8", errors="replace")}))
            break
finally:
    os.close(terminal)
    if not waited:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(!pythonAvailable)("interactive shells on real disposable PTYs", () => {
  for (const [name, shell] of [["bash", bash], ["zsh", "/bin/zsh"]] as const) {
    it.skipIf(!existsSync(shell)).each([false, true])(`${name} preserves its terminal and exit/EOF with supported cwd handoff (EOF=%s)`, async (eof) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "cyberdeck-shell-pty-test-")));
      directories.push(root);
      const home = join(root, "home");
      const selected = join(root, "selected 'quotes' $(touch injected)\ntrailing\n");
      await mkdir(home);
      await mkdir(selected);
      const startup = String.raw`
PS1='CYBERDECK_PTY_READY> '
alias chosen='builtin cd -- "$CYBERDECK_TEST_SELECTED"'
`;
      if (name === "bash") {
        await writeFile(join(home, ".bash_profile"), startup + String.raw`
PROMPT_COMMAND='printf "%s\n" "$?" >> "$CYBERDECK_TEST_ROOT/prompts"'
trap 'printf "%s" "$?" > "$CYBERDECK_TEST_ROOT/exit-status"' EXIT
`);
      } else {
        await writeFile(join(home, ".zshenv"), 'printf sourced > "$CYBERDECK_TEST_ROOT/zshenv"\n');
        await writeFile(join(home, ".zshrc"), startup);
      }
      let shellStatus: number | undefined;
      let transcript = "";
      const cwd = await openInteractiveShell(root, {
        shell,
        insideTmux: true,
        zdotdir: home,
        spawnSync(_command, args) {
          const environment = { ...process.env, HOME: home, TERM: "xterm-256color",
            CYBERDECK_TEST_ROOT: root, CYBERDECK_TEST_SELECTED: selected };
          args.slice(0, name === "bash" ? -5 : -2).forEach((argument, index) => {
            if (argument !== "-e") return;
            const assignment = args[index + 1]!;
            const split = assignment.indexOf("=");
            Object.assign(environment, { [assignment.slice(0, split)]: assignment.slice(split + 1) });
          });
          const proof = spawnSync("python3", ["-c", PTY_DRIVER, JSON.stringify({
            cwd: root, command: args.slice(name === "bash" ? -5 : -2), environment, eof,
          })], { encoding: "utf8", timeout: 8_000 });
          expect(proof.error).toBeUndefined();
          expect(proof.status, proof.stderr).toBe(0);
          const report = JSON.parse(proof.stdout) as { status: number; transcript: string };
          shellStatus = report.status;
          transcript = report.transcript;
          return { status: report.status };
        },
      });
      expect(cwd).toBe(name === "zsh" || bashCapturesCwd ? selected : undefined);
      expect(shellStatus).toBe(eof ? 0 : 11);
      expect(transcript).toMatch(/\r(?:\n)?CYBERDECK_PTY_OK\r\n/u);
      expect(existsSync(join(root, "injected"))).toBe(false);
      if (name === "bash") {
        expect(await readFile(join(root, "exit-status"), "utf8")).toBe(eof ? "0" : "11");
        expect(await readFile(join(root, "prompts"), "utf8")).toBe("0\n0\n0\n");
      } else {
        expect(await readFile(join(root, "zshenv"), "utf8")).toBe("sourced");
      }
    });
  }
});
