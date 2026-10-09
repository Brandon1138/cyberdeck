# Ubuntu 24.04 on WSL2: first installation

This guide sets up Cyberdeck with the Linux Codex, Claude Code and Cursor CLIs. Run the
PowerShell section on Windows; run every other command inside Ubuntu. Provider accounts and
authentication remain your own. The full [Linux installation guide](linux-install.md) covers
other distributions, native dependencies and custom state locations.

## 1. Install or check WSL2

For a new WSL installation, open administrator PowerShell:

```powershell
wsl --install -d Ubuntu-24.04
```

Restart Windows if requested, open Ubuntu 24.04, and create your Linux username and password.
For an existing distribution, check its version from PowerShell before changing anything:

```powershell
wsl --list --verbose
```

The Ubuntu distribution must show version **2**. See Microsoft's
[WSL installation instructions](https://learn.microsoft.com/en-us/windows/wsl/install).

## 2. Set up Ubuntu and Linux Node

In Ubuntu's Bash shell:

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 git curl ca-certificates tmux
```

Cyberdeck requires Node >=24.18.0 and <25. A per-user Linux Node installation avoids global npm
permission problems. If you already have a Linux Node version manager, select that version there.
For a fresh setup using [nvm](https://github.com/nvm-sh/nvm#installing-and-updating):

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24.18.0
nvm use 24.18.0
nvm alias default 24.18.0
```

Check `node --version`, `command -v node`, `command -v npm`, and `tmux -V`. Node and npm must
resolve to Linux installations; tmux must be >=3.3. Keep projects under your Linux home directory:

```bash
mkdir -p "$HOME/code"
```

Clone your actual project into that directory. Keep Cyberdeck/provider state on the Linux
filesystem too; Windows-mounted directories such as `/mnt/c` have different socket, permission
and native-build behavior.

## 3. Install and authenticate each provider

Run the official Linux installers inside Ubuntu:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
curl -fsSL https://claude.ai/install.sh | bash
curl -fsSL https://cursor.com/install | bash
export PATH="$HOME/.local/bin:$PATH"
```

Keep that PATH entry in your own Bash startup configuration if the installers have not already
added it. Verify `codex --version`, `claude --version`, and `agent --version`. Cyberdeck invokes
Cursor's **`agent`** executable; the Windows Cursor desktop editor does not supply that Linux CLI.

From your project directory, start `codex`, complete its sign-in, and exit normally. Repeat with
`claude` and `agent`, following each CLI's authentication prompts. Verify each CLI can answer a
small request independently before opening it through Cyberdeck. Those requests use your provider
account. A CLI version check alone does not prove authentication or model access.

Official setup references:
[Codex CLI](https://learn.chatgpt.com/docs/codex/cli),
[Codex on WSL](https://learn.chatgpt.com/docs/windows/wsl),
[Claude Code](https://code.claude.com/docs/en/setup), and
[Cursor CLI](https://cursor.com/cli).

## 4. Install Cyberdeck

**Release prerequisite:** the npm release must contain the Linux/WSL2 changes from PR #139.
Check the registry before installing:

```bash
npm view @ishmael38/cyberdeck@next version os engines --json
```

Proceed with the npm install only when `os` includes `linux`. The older macOS-only
`0.1.0-alpha.2` publication cannot be used on WSL. Until a Linux-capable release is published,
use the [source-built tarball procedure](linux-install.md#install-the-package).

```bash
npm install -g @ishmael38/cyberdeck@next
umask 077
install -d -m 700 "$HOME/.local/state/cyberdeck"
cyberdeck --version
cyberdeck --help
```

Run these with your Linux Node installation, without `sudo npm`. Keep npm dependency build
scripts enabled so `node-pty` can compile. Cyberdeck state defaults to
`~/.local/state/cyberdeck`; it is separate from each provider's authentication and settings.

## 5. Open Fleet and verify sessions

From your project's Linux directory, run `cyberdeck` to open Fleet. Select a provider/model
explicitly with `/model`, then send a small task. Check Codex, Claude and Cursor individually.
Detach from a provider with **Ctrl+]** and reopen the same conversation from Fleet. Detaching
does not stop the provider.

For the tmux cockpit, choose an orchestrator explicitly. For example:

```bash
cyberdeck cockpit --orchestrator codex
```

Codex and Claude orchestrators enable their native Remote Control, so first-party account
access and successful RC setup are additional requirements. A relay connection is separate from
phone pairing and a message-delivery test. No phone pairing is required for the plain Fleet path.

Before calling your setup accepted, confirm: an authenticated response from each CLI and from
each provider through Fleet; detach and reopen of the same conversation; and, if used, cockpit
launch and the clipboard gesture below. Hosted installation checks do not establish these on
your desktop.

## Windows Terminal keys and clipboard

Windows Terminal can consume Ctrl+V and Alt+Enter before Fleet sees them. Merge these entries
into your existing `keybindings` array in Windows Terminal's settings; preserve other entries:

```json
{ "id": null, "keys": "ctrl+v" },
{ "id": null, "keys": "alt+enter" }
```

Ctrl+Shift+V remains text paste. For an image, copy a screenshot in Windows and press Ctrl+V in
Fleet's composer. The WSL bridge needs Windows interoperability and `powershell.exe` on the
Linux PATH. It does not require WSLg. Image prompts are supported for Codex and Claude. See
[desktop integration](linux-desktop.md) for failures and limits.

Neovim is optional. If you want Ctrl+N integration, install Neovim >=0.10 and configure the
Lua module shipped with your installed Cyberdeck using the [Neovim guide](linux-nvim.md).

## Optional OpenRouter routing

OpenRouter is not a separate Cyberdeck provider adapter. Its
[Claude Code integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration)
routes Claude's native API through a different endpoint and credential. Cyberdeck's worker
environment forwards reviewed names only: the endpoint can be forwarded, but ambient API keys
and `ANTHROPIC_AUTH_TOKEN` are not inherited. Copying shell exports from that guide is therefore
not sufficient to establish broker-launched authentication.

Keep the first installation on the providers' own sign-ins. Treat OpenRouter as a separate
worker-routing setup with scoped provider configuration, explicit model selection and a live
verification of authentication and billing. Codex and Claude orchestrators deliberately pin
first-party endpoints for Remote Control; configuring worker routing does not change that policy.
Do not put API keys into repository-tracked settings or send them to another person for setup.
