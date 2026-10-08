# Native macOS and Linux acceptance

The `CI` workflow keeps the `verify` macOS full gate and adds full native Linux gates on
`ubuntu-24.04` (x64) and `ubuntu-24.04-arm` (arm64). Every full gate uses Node **24.18.0**,
Corepack-selected pnpm **11.5.0**, and a frozen lockfile. Gates run typecheck, the complete Vitest
suite, build, isolated offline Promptfoo evaluations, and the production dependency audit.

Before tests, `scripts/ci-native-preflight.mjs` requires tmux **>=3.3**, Neovim **>=0.10**, zsh,
Bash, Git, Python, make, and a C++ compiler. Missing native dependencies fail the job instead of
allowing existing `skipIf` suites to pass without running. All three native gates install Neovim
**0.11.5** from official tarballs with checked, committed SHA-256 digests; macOS retains its native
state paths and runtime behavior.

## Packed artifact proof

`scripts/ci-packed-acceptance.mjs` runs only on disposable GitHub-hosted runners. It refuses
operator hosts and self-hosted runners before any installation, state inspection, or broker
lifecycle command. Do not spoof the runner environment to run it locally: changing XDG state paths
does **not** isolate the broker's per-UID `/tmp/cyberdeck-<uid>.sock` address.

The script packs the completed build with `npm pack --ignore-scripts`, checks required publication
files and the packaged Cyberdeck Lua module, and rejects development-only files. It then:

1. Installs the tarball globally into a fresh temporary prefix with normal npm lifecycle scripts.
2. Runs the installed CLI's version and help from outside the source checkout.
3. Resolves `node-pty` from the installed package and exchanges real input/output with Bash and zsh.
4. Loads the installed Lua asset in real headless Neovim and proves live-buffer lock and release.
5. Refuses any pre-existing broker socket or state, then starts, queries, and stops the installed
   broker. It requires healthy status, a real process ID, and zero active workers, waits for
   shutdown, and attempts cleanup on failure.

Linux uses fresh XDG state/config/cache/data/runtime directories. macOS uses its unchanged native
Application Support path on its disposable runner. Child environments include only runtime paths
and test state; provider credentials and operator tmux variables are not forwarded. No provider,
model, or authentication gate is invoked. Reports, broker status, and broker logs are uploaded as
small acceptance artifacts.

The Lua assertion accepts either `contrib/nvim/lua/cyberdeck/init.lua` or a build-contained Lua
layout. It fails if packaging omits or duplicates the module.

## Distro install and compiler fallback

After both Linux full gates pass, `.github/workflows/native-linux-acceptance.yml` consumes their
packed artifacts on plain GitHub-hosted distro test environments:

- Ubuntu 24.04, `ubuntu:noble-20260917`: native x64 and arm64.
- Debian 13, `debian:trixie-20261005-slim`: native x64 and arm64.
- Arch Linux, `archlinux:base-20261004.0.606936`: native x64.

These are isolated distro acceptance hosts, with no Cyberdeck provider-container implementation.
Each installs its distro's compiler tools, the same Node/pnpm/Neovim versions, and the same packed
artifact without rebuilding Cyberdeck from source. `npm_config_build_from_source=true` forces
node-pty's documented compiler fallback. Acceptance requires `build/Release/pty.node`, verifies
prebuilds were removed, then exercises the installed CLI, native PTY, Lua module, and broker.

Versioned image tags pin the starting distro snapshots. Their package managers install current
security updates, so exact tmux/compiler package versions can change; preflight logs the actual
versions and enforces compatibility minimums. npm installation deliberately exercises the published
package's dependency resolution, which can differ from the source pnpm lockfile.

## Evidence limits

Workflow definitions and local script tests are not completed Linux install proof. Native Linux
x64/arm64 and distro acceptance remain unproved until the corresponding hosted jobs pass on the
integrated commit. Official Arch Linux images cover x64; Arch arm64 is unproved and is not rejected
by Cyberdeck's installer. Other Linux architectures and distributions remain unproved.

These gates do not prove WSL2, Windows clipboard integration, a desktop clipboard server, interactive
terminal behavior, authenticated provider execution, or release readiness. The independent
`wsl-install.yml` workflow owns actual WSL2 installation and its synthetic Windows clipboard bridge.

Local, side-effect-free checks for this slice:

```sh
rtk proxy node --test tests/scripts/native-acceptance.test.mjs
rtk proxy bash -n scripts/ci-install-neovim.sh
rtk proxy node --check scripts/ci-native-preflight.mjs
rtk proxy node --check scripts/ci-packed-acceptance.mjs
```

## Primary sources for pins and architecture coverage

- [Neovim 0.11.5 release and asset digests](https://api.github.com/repos/neovim/neovim/releases/tags/v0.11.5).
- [node-pty 1.1.0 compiler fallback](https://github.com/microsoft/node-pty/blob/v1.1.0/scripts/prebuild.js).
- Artifact actions pinned to verified release commits:
  [upload-artifact 7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2),
  [download-artifact 8.0.2](https://github.com/actions/download-artifact/releases/tag/v8.0.2).
- [GitHub-hosted runner architecture labels](https://github.com/github/docs/blob/main/data/reusables/actions/supported-github-runners.md).
- Official Docker image manifests: [Ubuntu](https://github.com/docker-library/official-images/blob/master/library/ubuntu),
  [Debian](https://github.com/docker-library/official-images/blob/master/library/debian),
  [Arch Linux](https://github.com/docker-library/official-images/blob/master/library/archlinux).
