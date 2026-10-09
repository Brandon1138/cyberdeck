# Linux and WSL2 installation

For a fresh Ubuntu 24.04 installation on Windows, start with the
[WSL2 quickstart](linux-wsl-quickstart.md), including Codex, Claude Code and Cursor setup.

Cyberdeck supports native Linux and Linux distributions running under WSL2. Use Linux Node.js
24.18.0 or newer in the Node 24 release line (`>=24.18.0 <25`), and install and authenticate the
Linux versions of the provider CLIs you intend to use. The package retains native macOS support.
Windows Node.js, Windows provider executables, and WSL1 are not supported by this setup.

Fleet needs a terminal and the provider CLI. The tmux cockpit needs **tmux 3.3 or newer**; the
editor integration needs **Neovim 0.10 or newer**. Cyberdeck does not bundle these tools. Desktop
clipboard and browser helpers depend on the capabilities available in your desktop session.
WSL can read the Windows clipboard through its interoperability bridge without WSLg; a headless
native Linux terminal does not acquire a desktop by installing Cyberdeck.

Fleet's Ctrl+S popup returns its final cwd for zsh and ordinary GNU Bash 4+ login shells. See the
[shell setup guide](linux-shell.md) for startup behavior and the remaining Fish, legacy Bash and
POSIX-mode limitations. See the [Neovim setup guide](linux-nvim.md) for packaged Lua and verified
binaries when a distribution supplies an older Neovim.

## System dependencies

Install Python 3, make, and a C/C++ compiler before installing Cyberdeck. The native `node-pty`
dependency uses a matching prebuild when available and falls back to `node-gyp rebuild` otherwise.

Ubuntu or Debian:

```sh
sudo apt-get update
sudo apt-get install -y build-essential python3 git tmux neovim
```

Arch Linux:

```sh
sudo pacman -S --needed base-devel python git tmux neovim
```

Check the installed versions:

```sh
node --version
tmux -V
nvim --version
python3 --version
make --version
c++ --version
```

Older Ubuntu/Debian repositories may provide tmux or Neovim below the required versions. Use a
supported distribution release, distribution backports, or the tools' official installation
instructions to obtain tmux >=3.3 and Neovim >=0.10 before using those integrations. Distribution
Node packages may also be outside the supported Node 24 range; use a Linux Node version manager
to select the required release. Do not bypass the package's engine checks.

## WSL2

Confirm the distribution uses WSL version 2 with `wsl --list --verbose` from Windows, then run the
Linux installation steps inside that distribution. Install Node and each provider CLI there,
including their authentication setup; do not reuse Windows npm's global install directory.
`command -v node` and `command -v npm` must identify Linux installations, not paths below `/mnt/c`.
Check provider executables the same way and authenticate them from the Linux shell.

Keep the repository, Cyberdeck state, and provider state on the Linux filesystem, such as
`/home/<user>/code` and `/home/<user>/.local/state`. Avoid `/mnt/c` and other Windows-mounted paths
for private state, native dependencies, and Unix sockets: permissions and filesystem behavior
differ. WSLg supplies graphical services when enabled; browser authentication through Windows
also depends on WSL interoperability being enabled.

Windows Terminal intercepts Ctrl+V for terminal paste and Alt+Enter for fullscreen by default.
To let Fleet receive its image-attachment and multiline gestures, merge these entries into the
terminal's `settings.json` `keybindings` array:

```json
{
  "keybindings": [
    { "id": null, "keys": "ctrl+v" },
    { "id": null, "keys": "alt+enter" }
  ]
}
```

See Microsoft's [Windows Terminal keybindings](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/actions#unbind-keys-disable-keybindings).
Ctrl+Shift+V remains the default text-paste binding. Cyberdeck's detach gesture remains Ctrl+].

## Private durable state

Linux defaults to `~/.local/state/cyberdeck/`. An absolute `XDG_STATE_HOME` changes this to
`$XDG_STATE_HOME/cyberdeck/`; unset, empty, and relative values use the default. `~` inside an
environment value is not expanded. macOS still uses `~/Library/Application Support/Cyberdeck/`
and ignores `XDG_STATE_HOME` for Cyberdeck's state.

Set a private umask before the first launch. For the default Linux location:

```sh
umask 077
install -d -m 700 "$HOME/.local/state/cyberdeck"
```

For a custom location, set an absolute `XDG_STATE_HOME` in the shell that starts Cyberdeck and
create its `cyberdeck` subdirectory with mode 700. Keep that setting consistent across broker and
client invocations. Config lives in `config.json` below the state directory. Existing state is
not moved or migrated, and changing the setting does not relocate a running broker. Choose the
location before starting a new installation; do not change it under existing sessions.

The broker socket remains `/tmp/cyberdeck-<uid>.sock`, with mode 600, independent of durable
state and `XDG_RUNTIME_DIR`. Durable state must not live in `/tmp` or the session runtime directory.

Provider children inherit only reviewed environment names. Linux adds `DISPLAY`,
`WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, and `XDG_DATA_HOME`
for display, browser, and desktop keyring services; `WSL_INTEROP` and `WSL_DISTRO_NAME` support
WSL's Windows-browser bridge. This passes service endpoints and paths, not arbitrary environment
variables or API keys. `WSLENV` and ambient `SSH_AUTH_SOCK` are not inherited; existing explicit
SSH-agent grants remain required. Orchestrators still withhold inherited provider proxy routing.

## Install the package

Once a release containing Linux support is published, install it with Linux npm under your Linux
Node installation:

```sh
npm install -g @ishmael38/cyberdeck@next
cyberdeck --help
```

Before that release exists, build and pack a checkout containing the Linux patch with pnpm 11.5.0:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack --pack-destination /tmp
```

Install the resulting tarball using its absolute path, for example for version 0.1.0-alpha.2:

```sh
npm install -g /tmp/ishmael38-cyberdeck-0.1.0-alpha.2.tgz
cyberdeck --help
```

The installed `cyberdeck` command runs the package's `dist/src/cli.js` entry point. Use that
command for normal operation; source `pnpm dev` is not the installed entry point. `cyberdeck`
opens Fleet. To open the tmux cockpit, change to your repository first:

```sh
cd /absolute/path/to/repository
cyberdeck cockpit --orchestrator codex
```

Authenticate providers before launching their sessions. Detach from an attached provider with
`Ctrl+]`; `Ctrl+[` remains Esc and is never a detach binding. No forced Kitty keyboard protocol
is required.

Source installs already allow the `node-pty` and `esbuild` dependency build scripts in
`pnpm-workspace.yaml`. Do not use `--ignore-scripts`: it can leave the native PTY unavailable.
If Python discovery fails, retry the install with `npm_config_python=/usr/bin/python3` in that
shell. Keep dependency builds enabled for packaged npm installs too. Cyberdeck's postinstall
permission fix for Darwin's `spawn-helper` remains Darwin-only; Linux uses node-pty's native
install/build path.

Linux installation and live provider behavior must be validated on Linux or WSL2. Passing
platform-contract tests on macOS does not prove a Linux native build or desktop authentication.
