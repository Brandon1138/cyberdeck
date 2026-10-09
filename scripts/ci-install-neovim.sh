#!/usr/bin/env bash
# Official release assets; SHA-256 digests verified against upstream release metadata.
set -euo pipefail
destination=${1:?Pass a fresh installation directory}
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    asset=nvim-linux-x86_64
    checksum=b2f91117be5b5ea39edd7297156dc2a4a8df4add6c95a90809a8df19e7ab6f52 ;;
  Linux-aarch64|Linux-arm64)
    asset=nvim-linux-arm64
    checksum=ea4f9a31b11cc1477ff014aebb7b207684e7280f94ffa97abdab6cacd9b98519 ;;
  Darwin-arm64)
    asset=nvim-macos-arm64
    checksum=79143d3b408f7034f90b7cf59af2276de09ef8a4c2f1a28e4c99581b249d3107 ;;
  Darwin-x86_64)
    asset=nvim-macos-x86_64
    checksum=6612760a7037ca2518e456908baf5e43101fa79819d18979fc4d4e8441d9dfa5 ;;
  *) printf 'No pinned Neovim CI asset for this host\n' >&2; exit 1 ;;
esac
mkdir "$destination"
archive="$destination/$asset.tar.gz"
curl --fail --location --retry 3 --output "$archive" \
  "https://github.com/neovim/neovim/releases/download/v0.11.5/$asset.tar.gz"
if command -v sha256sum >/dev/null; then
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --strict
else
  printf '%s  %s\n' "$checksum" "$archive" | shasum --algorithm 256 --check
fi
tar -xzf "$archive" -C "$destination" --strip-components=1
"$destination/bin/nvim" --version
