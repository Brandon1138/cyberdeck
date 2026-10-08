# Interactive shell cwd handoff

Fleet's Ctrl+S shell popup requires tmux 3.3 or newer and Cyberdeck's supported Node 24 runtime.
GNU Bash 4+ in normal Bash mode and zsh return the directory selected inside the popup when the
shell exits. Spaces, quotes, and embedded or trailing newlines in paths are preserved. Fleet
validates the result as an accessible directory and resolves symlinks.

Bash keeps its real HOME and login-shell state. A private bootstrap enters through GNU Bash's
POSIX `ENV` startup path, restores normal Bash mode, shell options, and the original `ENV`, then
loads `/etc/profile` and the first readable file among `~/.bash_profile`, `~/.bash_login`, and
`~/.profile`, exactly once. Bash reads `~/.bashrc` when the operator's login files source it.
This all happens during startup, before Bash initializes history and Readline. No startup file
is edited; aliases, functions, completion, and string or array `PROMPT_COMMAND` stay in the same
Bash process. Bash runs every prompt command itself, including the first prompt. The bootstrap
does not assign to `PROMPT_COMMAND`, so startup files can replace it or make it readonly.

A login Bash ignores `--rcfile`; installing a prompt hook through the environment alone can also
be overwritten by a profile. Replaying profiles from the first prompt changes history initialization
and can affect saved history. The startup bootstrap avoids both problems. A short Node launcher
checks the Bash version without reading startup files, then uses `process.execve` to hand the
existing terminal directly to Bash. There is no wrapper REPL. Shell and bootstrap paths travel as
argv/environment data. `ENV` expands a fixed variable reference once, so quotes, command
substitutions, and newlines in the bootstrap path remain filename data.

After the login files run, an EXIT hook records Bash's cwd before running the existing EXIT handler
with its original status. Direct `exit`, bare `exit` after a failed command, EOF/Ctrl+D, and the
user's explicit exit status in an EXIT trap keep their normal behavior. Bash still runs its login
logout files and manages history normally. The result and bootstrap live in a private temporary
directory and are removed after the popup closes, including when spawning fails.

The existing zsh startup, `chpwd`, and `zshexit` hooks are unchanged. A popup is not a tmux pane;
`pane_current_path` and `list-panes` cannot identify its cwd. Fish, legacy Bash 3.2 (including
Apple's Bash), and explicitly selected POSIX-mode Bash keep their existing native popup behavior
without cwd handoff. Apple Bash 3.2 does not honor the GNU POSIX `ENV` startup path. Bash records
on EXIT, so force-killing it or replacing its EXIT trap after startup can prevent handoff.
Startup files that exit before the bootstrap installs the hook can also prevent handoff.
Using `exec` to replace Bash also bypasses EXIT capture.

Focused tests support `CYBERDECK_TEST_BASH=/absolute/path/to/bash` for modern GNU Bash proofs on
macOS. Real shell/PTY proofs on macOS are separate from native Linux/WSL2 and actual tmux popup
validation. Close the popup with `exit` or Ctrl+D. Provider detach remains Ctrl+]; Ctrl+[ and Kitty
keyboard protocol changes are outside this feature.
