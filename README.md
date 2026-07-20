# Cyberdeck

Cyberdeck is a neutral local broker for durable Claude and Codex terminal sessions. Provider processes run in broker-owned PTYs, so they can move between attached/interactive and detached/headless presentation without being restarted. tmux is an optional cockpit view, not the session owner.

> **Stop and detach are different.** `cyberdeck stop <session-id>` terminates the provider process. Pressing `Ctrl-]`, closing an attached terminal, or closing a tmux pane only detaches that view; the session keeps running while the broker is alive.

## Requirements and installation

The project pins Node 24.18.0 through mise and pnpm 11.5.0 through Corepack/package metadata. Claude Code, Codex CLI, and tmux must be installed separately for the corresponding live features.

```bash
cd /Users/brandon/code/personal/cyberdeck
mise install
mise exec -- corepack enable
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm build
mise exec -- pnpm link --global
```

If the global link is not desired, replace `cyberdeck` in the examples with `node dist/src/cli.js` from the repository root.

## Broker and cockpit

```bash
cyberdeck broker start
cyberdeck broker status
cyberdeck cockpit
cyberdeck list
```

The cockpit creates a tmux session with a read-only dashboard and an ordinary shell. Create or close additional panes freely; the broker, not tmux, owns provider sessions.

Shut down deliberately when finished:

```bash
cyberdeck broker stop
```

Broker shutdown ends active PTYs in Phase 1. Sessions survive client and pane detachment, but they do not survive broker death or restart.

## Start a session

Every start requires an explicit provider. The model and opaque role string are optional and independent.

Detached/headless Codex using its native configured default:

```bash
cyberdeck start --provider codex --cwd /absolute/project/path --sandbox read-only --name codex-session
```

Attached/interactive Claude using an explicitly chosen provider-native model string:

```bash
cyberdeck start --provider claude --cwd /absolute/project/path --sandbox workspace-write --model MODEL_NAME --role any-user-defined-label --attach
```

Cyberdeck does not recommend or automatically select a model. If `--model` is omitted, the provider's native default is used. Confirm that default yourself: an omitted Claude model may be Fable depending on local configuration.

The read-only mapping uses each provider's native restricted mode. Claude is always spawned with `DISABLE_UPDATES=1`.

## Attach, watch, detach, and steer

```bash
cyberdeck attach SESSION_ID
cyberdeck watch SESSION_ID
cyberdeck send SESSION_ID "Summarize the current state without changing files."
cyberdeck logs SESSION_ID
```

`attach` is the single controlling client. `watch` is a read-only observer and multiple watchers are allowed. Both replay buffered output before following live output. Press `Ctrl-]` to detach from either view.

`send` submits input without opening an interactive client. `logs` prints the current replay snapshot.

## Delegate one explicitly selected worker

Delegation still requires an explicit provider; the role is only an optional user-defined label:

```bash
cyberdeck delegate --parent PARENT_SESSION_ID --provider codex --cwd /absolute/project/path --sandbox read-only --role my-label --name child-session
```

Cyberdeck does not infer a provider or model from the role. Delegated Fable is rejected before launch with `FABLE_REQUIRES_EXPLICIT_HUMAN_START`. A top-level Fable start can only be a deliberate human command and is never needed for tests or runtime probes. Opus has no special restriction.

## Stop and inspect

```bash
cyberdeck list --json
cyberdeck logs SESSION_ID
cyberdeck stop SESSION_ID
```

Use `stop` only when the provider process should end. Closing a terminal or tmux pane is not a substitute for `stop`, and `stop` is not a detach operation.

## Test, check, build, and probe

The automated suite uses a deterministic fake terminal agent and makes no Claude, Codex, or Fable model call.

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
mise exec -- pnpm probe
```

`probe` is read-only: it reports installed runtime versions and does not start provider sessions or change authentication.

## Phase 1 boundary

Phase 1 provides broker-owned Claude and Codex PTYs, explicit starts, one bounded delegation primitive, attach/watch/detach, input steering, replay, explicit stop, and a tmux projection. It does not provide workflows, automatic routing or fallback, provider ranking, model recommendations, semantic memory, worktree orchestration, Cursor, or Antigravity.

See `docs/architecture/session-model.md` for the precise state and ownership model and `docs/setup/phase-1-acceptance.md` for verified live behavior and current limitations.
