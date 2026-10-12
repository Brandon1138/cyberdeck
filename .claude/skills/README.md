# Project-scope skills

Cyberdeck launches orchestrators and Claude workers with `--setting-sources project,local`, so
skills installed at user scope (`~/.claude/skills`, plugins) are invisible to them. Skills that
workers should have live here instead.

## impeccable

Vendored from the `impeccable` plugin (https://github.com/pbakaus/impeccable, Apache 2.0),
plugin release 4.5.2, `skills/impeccable/` only. The plugin's SessionStart/PostToolUse/Stop hooks
and its root-level subagents are not vendored; a worker gets the skill, not the hooks.

To update: copy `~/.claude/plugins/cache/impeccable/impeccable/<version>/skills/impeccable/` over
this directory and bump the version above.
