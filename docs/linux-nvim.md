# Neovim setup on Linux, macOS and WSL2

Fleet's optional Ctrl+N surface requires **Neovim >=0.10** and tmux >=3.3. Cyberdeck talks only to
Neovim in Fleet's own tmux window, using `--remote-expr`. It never scans other windows or socket
directories and never sends keystrokes with `--remote-send`. Detach from a provider remains Ctrl+];
Ctrl+[ is Esc, and no provider needs forced Kitty keyboard protocol.

The npm package includes `contrib/nvim/lua/cyberdeck/init.lua`. You choose its path in your own
Neovim configuration; installing Cyberdeck does not edit `~/.config/nvim`, install live plugins,
or add keymaps. Your config owns presentation and `listen({ on_open = ... })` hooks. See the
[module guide](../contrib/nvim/README.md) and [architecture contract](architecture/nvim-surface.md).

## Check the Neovim executable first

In the Linux shell that runs Fleet (inside the distribution for WSL2):

```sh
command -v nvim
nvim --version
```

Ubuntu/Debian's default `apt install neovim` is not a version guarantee. Older supported distro
releases can supply Neovim 0.7 or 0.9, which lacks the Lua APIs this module uses. Inspect the
candidate with `apt-cache policy neovim`; use a distro package or backport only if it is >=0.10.
Otherwise use the official binary below. Do not try to repair an older Neovim with a Lua plugin.

On macOS, Homebrew's `brew install neovim` provides a native executable; verify its version in the
same shell. On WSL2, use the Linux executable and Linux npm installation, not Windows `nvim.exe`
or an installation under `/mnt/c`. Keep repositories and runtime files on the Linux filesystem.

## Official binaries for Ubuntu/Debian and WSL2

This example pins **Neovim 0.11.5**, matching Cyberdeck's native CI checks. It installs alongside
your existing executable into a new directory, without replacing the distro package. Digests come
from the [official release metadata](https://api.github.com/repos/neovim/neovim/releases/tags/v0.11.5).
Run in Bash or zsh on a glibc Linux system with `curl`, `tar` and `sha256sum` available:

```sh
case "$(uname -m)" in
  x86_64)
    nvim_asset=nvim-linux-x86_64
    nvim_sha256=b2f91117be5b5ea39edd7297156dc2a4a8df4add6c95a90809a8df19e7ab6f52 ;;
  aarch64|arm64)
    nvim_asset=nvim-linux-arm64
    nvim_sha256=ea4f9a31b11cc1477ff014aebb7b207684e7280f94ffa97abdab6cacd9b98519 ;;
  *) printf 'Use upstream instructions for this architecture\n' >&2; exit 1 ;;
esac
nvim_download=$(mktemp -d)
nvim_install="$HOME/.local/opt/nvim-0.11.5"
if [ -e "$nvim_install" ]; then
  printf 'Installation directory already exists: %s\n' "$nvim_install" >&2
  exit 1
fi
curl --fail --location --retry 3 \
  --output "$nvim_download/$nvim_asset.tar.gz" \
  "https://github.com/neovim/neovim/releases/download/v0.11.5/$nvim_asset.tar.gz" &&
printf '%s  %s\n' "$nvim_sha256" "$nvim_download/$nvim_asset.tar.gz" | sha256sum --check --strict &&
mkdir -p "$HOME/.local/opt" &&
mkdir "$nvim_install" &&
tar -xzf "$nvim_download/$nvim_asset.tar.gz" -C "$nvim_install" --strip-components=1 &&
"$nvim_install/bin/nvim" --version
```

Continue only if checksum verification and `--version` succeed. Select it in your launching shell:

```sh
export PATH="$HOME/.local/opt/nvim-0.11.5/bin:$PATH"
command -v nvim
nvim --version
```

Add that PATH entry to your own shell startup file if desired. A running Neovim keeps its existing
executable; PATH changes apply to subsequent launches. If a binary cannot run on your distro, follow
[upstream installation/build instructions](https://github.com/neovim/neovim/blob/v0.11.5/INSTALL.md)
instead of downgrading below 0.10. This guide does not establish live Linux or WSL2 acceptance.

## Point manual config at the installed Lua module

Use the same Node/npm installation that installed the `cyberdeck` command:

```sh
command -v cyberdeck
npm root -g
cyberdeck_nvim_runtime="$(npm root -g)/@ishmael38/cyberdeck/contrib/nvim"
printf '%s\n' "$cyberdeck_nvim_runtime"
test -r "$cyberdeck_nvim_runtime/lua/cyberdeck/init.lua"
```

The printed directory is the runtime root; `lua/cyberdeck/init.lua` is below it. If the readability
check fails, that npm prefix does not contain the patched package. Install a release or packed
artifact containing this patch using the [Linux installation guide](linux-install.md). For a
custom npm `--prefix`, use `npm root -g --prefix /your/prefix`. This is an explicit installation
lookup, not checkout guessing. A source client should use its deliberately chosen source checkout's
`contrib/nvim` directory instead. Do not silently fall back to another checkout.

In your own `init.lua`, replace the path below with the printed absolute runtime root:

```lua
assert(vim.fn.has("nvim-0.10") == 1, "Cyberdeck requires Neovim >=0.10")
local runtime = "/absolute/npm/root/@ishmael38/cyberdeck/contrib/nvim"
assert(vim.uv.fs_stat(runtime .. "/lua/cyberdeck/init.lua"),
  "Cyberdeck Lua module not found: " .. runtime)
vim.opt.runtimepath:prepend(runtime)
require("cyberdeck").listen()
```

A plugin manager that rewrites `runtimepath` should own the local runtime entry. For lazy.nvim,
place this spec in your existing config instead of the manual `runtimepath` addition:

```lua
{
  dir = "/absolute/npm/root/@ishmael38/cyberdeck/contrib/nvim",
  name = "cyberdeck",
  lazy = false,
  config = function()
    require("cyberdeck").listen()
  end,
}
```

Start Neovim with this config in Fleet's tmux window. `listen()` is inert outside tmux. No explorer,
diff plugin or module keymap is required. Ctrl+N can then open the selected worker or checkout.

## Version failures and deferred limits

Every RPC checks the loaded module's `protocol_version` before applying `open` or `refresh`, in
the same remote expression. A missing module, older module without this export, mismatched version,
or missing entry point returns a clear error; it does not change tabs, lists or buffer locks. The
wire version is separate from the npm release version: source checkouts can differ while sharing
the same package version. Compatible releases can share a wire version. Incompatible changes must
bump both TypeScript and Lua exports. The payload also carries `protocolVersion`; a new Lua module
rejects missing or mismatched payload versions even if an older client calls its entry point directly.

If an RPC is rejected, point your config at the module belonging to your chosen client and start
Neovim with that config when ready. Reloading a file on disk does not replace Lua already cached by
a running Neovim. Do not replace `package.loaded` in a live instance: doing so loses its guards.
A failed completion refresh intentionally leaves a live buffer locked; after checking the worker's
state, the operator can use `:CyberdeckUnlock` or `:CyberdeckUnlock!` explicitly.

The existing `/tmp/cyberdeck-nvim-<uid>/pane-<index>.sock` namespace is unchanged. Concurrent
Cyberdecks owned by the same uid can still collide; instance namespacing remains deferred. Baselines
still require `origin/HEAD`; no concurrent-instance, upstream or base-ref guess is added here.
