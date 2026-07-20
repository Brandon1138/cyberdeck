# Phase 1 acceptance

Performed on 2026-07-20 in `/Users/brandon/code/personal/cyberdeck`. All provider starts used an explicit provider and read-only sandbox. No Fable prompt or top-level Fable start was made.

## Automated gate

Before live acceptance:

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
```

Result: 15 test files and 60 tests passed, TypeScript completed without errors, and `dist/src/cli.js` existed.

## Broker and cockpit

```bash
mise exec -- pnpm build
node dist/src/cli.js broker start
node dist/src/cli.js broker status
node dist/src/cli.js cockpit
tmux list-panes -t cyberdeck -F '#{pane_id} #{pane_current_command}'
tmux capture-pane -pt cyberdeck:0.0
```

The broker reported healthy with PID `70962`. The cockpit created a `cyberdeck` tmux session containing a Node dashboard pane and an ordinary zsh pane, and the captured dashboard rendered the session headers. The command runner's terminal could not become the tmux client (`terminal does not support clear`), so the cockpit was inspected through tmux metadata and capture rather than as an attached local client. This is a limitation of the acceptance terminal, not evidence that tmux panes own provider processes.

## Top-level Codex

```bash
node dist/src/cli.js start --provider codex --cwd /Users/brandon/code/personal/cyberdeck --sandbox read-only --name codex-proof
node dist/src/cli.js attach 5d802dc2-9254-4d2f-b2d2-9c99c5593958
node dist/src/cli.js list
node dist/src/cli.js logs 5d802dc2-9254-4d2f-b2d2-9c99c5593958
```

Session `5d802dc2-9254-4d2f-b2d2-9c99c5593958` ran as PID `71462`. The native UI identified Codex 0.144.6, model `gpt-5.6-sol high`, and the requested working directory. It answered a read-only runtime-and-directory prompt and reported that it modified no files.

The client detached with `Ctrl-]` while Codex was working. `cyberdeck list` still showed the same session active and detached, and `ps` showed the same provider PID alive. Codex completed a three-bullet read-only repository summary while no controller was attached; a later attach replayed the completed output and retained a usable native screen. This was continued execution in the same PTY and process, not stop-and-resume.

## Top-level Claude

```bash
node dist/src/cli.js start --provider claude --cwd /Users/brandon/code/personal/cyberdeck --sandbox read-only --name claude-proof
node dist/src/cli.js attach 9196ef42-4db6-481d-a2bc-25a5e17e1dfa
```

Session `9196ef42-4db6-481d-a2bc-25a5e17e1dfa` ran as PID `71464`. The native Claude 2.1.214 UI attached successfully and displayed `Fable 5 with high effort · Claude Pro` as its configured default. Acceptance immediately detached with `Ctrl-]` without sending a prompt. Start, attach, detach, and explicit stop were therefore observed mechanically, but Claude steering, detached continuation, and conversational replay were not verified. No Fable call was made.

The earlier `claude auth status` result said `loggedIn:false`, while the interactive UI welcomed the user and displayed a Pro configuration. That inconsistency is recorded without treating either signal as proof of a successful model call.

## Pane independence

A temporary tmux pane ran:

```bash
node dist/src/cli.js attach 5d802dc2-9254-4d2f-b2d2-9c99c5593958
```

While attached, `cyberdeck list` showed the Codex session controlled. After `tmux kill-pane` closed that view, the session became detached, PID `71462` remained alive, and the dashboard and shell panes remained. Reattachment to that session succeeded. Closing a pane therefore removed only a presentation client.

## Delegated Codex and Fable policy

```bash
node dist/src/cli.js delegate --parent 5d802dc2-9254-4d2f-b2d2-9c99c5593958 --provider codex --cwd /Users/brandon/code/personal/cyberdeck --sandbox read-only --role scout-proof --name delegated-proof
node dist/src/cli.js attach 73e9de9b-c8e0-44f9-9a01-109aeb2ab39d
node dist/src/cli.js delegate --parent 5d802dc2-9254-4d2f-b2d2-9c99c5593958 --provider claude --cwd /Users/brandon/code/personal/cyberdeck --sandbox read-only --model fable --role rejected-proof
```

The child session `73e9de9b-c8e0-44f9-9a01-109aeb2ab39d` ran as PID `73779`, retained the opaque role string `scout-proof`, and preserved the parent link. It was attached, given a read-only prompt, detached while working, and produced a no-changes response in the same continuing process. It was then stopped explicitly during cleanup.

The delegated Fable attempt returned exactly `FABLE_REQUIRES_EXPLICIT_HUMAN_START`. Session-list entries and provider PIDs were unchanged before and after the rejection, so no Claude provider process was started and no Fable usage was spent. The automated policy and CLI tests cover the top-level Fable allowance; live acceptance intentionally did not exercise it.

## Cleanup and verdict

```bash
node dist/src/cli.js stop 73e9de9b-c8e0-44f9-9a01-109aeb2ab39d
node dist/src/cli.js stop 5d802dc2-9254-4d2f-b2d2-9c99c5593958
node dist/src/cli.js stop 9196ef42-4db6-481d-a2bc-25a5e17e1dfa
node dist/src/cli.js broker stop
tmux kill-session -t cyberdeck
```

All three provider PIDs were absent, the broker socket was absent, and the temporary tmux server was gone after cleanup.

Codex demonstrated the complete Phase 1 attached/detached lifecycle, continued execution while detached, replay, steering, delegation, pane independence, and explicit stop. Claude demonstrated process launch and presentation lifecycle only. Full Claude acceptance remains blocked until the operator deliberately configures or selects an ordinary non-Fable Claude model; Cyberdeck must not silently route or select one.
