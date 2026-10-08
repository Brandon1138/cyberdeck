# Interactive Codex and Cyberdeck use the same dedicated native RC owner.
# Source this from .zshrc; the installer-managed codex executable stays untouched.
function codex() {
  if [[ ! -o interactive || ${CYBERDECK_PROCESS_ROLE:-} == worker ]]; then
    command codex "$@"
    return
  fi
  local remote_launcher="${HOME}/.local/share/cyberdeck/codex-remote.mjs"
  command node "$remote_launcher" run -- "$@"
}
