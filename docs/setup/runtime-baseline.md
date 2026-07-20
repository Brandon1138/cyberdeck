# Runtime baseline

Captured on 2026-07-20 in Europe/Bucharest during Setup and Phase 1 implementation.

## Read-only version probe

The probe passed only version flags. It supplied no prompt, started no agent session, made no model call, and changed no provider configuration.

```json
{
  "capturedAt": "2026-07-20T11:28:11.214Z",
  "platform": {
    "platform": "darwin",
    "release": "27.0.0",
    "arch": "arm64"
  },
  "results": {
    "node": {
      "executable": "/Users/brandon/.local/share/mise/installs/node/24.18.0/bin/node",
      "available": true,
      "output": "v24.18.0"
    },
    "pnpm": {
      "executable": "/Users/brandon/.local/share/mise/installs/node/24.18.0/bin/pnpm",
      "available": true,
      "output": "11.5.0"
    },
    "tmux": {
      "executable": "/opt/homebrew/bin/tmux",
      "available": true,
      "output": "tmux 3.6a"
    },
    "codex": {
      "executable": "/opt/homebrew/bin/codex",
      "available": true,
      "output": "codex-cli 0.144.6"
    },
    "claude": {
      "executable": "/opt/homebrew/bin/claude",
      "available": true,
      "output": "2.1.214 (Claude Code)"
    },
    "agent": {
      "executable": "/Users/brandon/.local/bin/agent",
      "available": true,
      "output": "2026.07.16-899851b"
    },
    "agy": {
      "executable": "/Users/brandon/.local/bin/agy",
      "available": true,
      "output": "1.1.4"
    }
  }
}
```

The global Node executable reported `v26.4.0` before entering mise; project commands use the pinned Node `v24.18.0` above.

## Authentication status

These exact read-only commands were run:

```bash
codex login status
claude auth status
```

Observed results:

- Codex: `Logged in using ChatGPT` (plus a sandbox-only warning that PATH aliases could not be created).
- Claude: `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`.

No authentication state was changed.

## Capability ledger before live acceptance

An observed capability is something demonstrated by the native runtime or Cyberdeck in this environment. A desired Cyberdeck capability is a product requirement and is not evidence that the underlying runtime has already demonstrated it.

| Capability | Codex observation | Claude observation | Desired Cyberdeck capability |
| --- | --- | --- | --- |
| Interactive start | Not yet exercised | Not yet exercised; auth currently unavailable | Start only with an explicit provider |
| Detach | Not yet exercised | Not yet exercised | Detach the view without stopping the provider |
| Reattach | Not yet exercised | Not yet exercised | Reattach to the same broker-owned PTY |
| Steering | Not yet exercised | Not yet exercised | A controller can send input after attachment |
| Cancellation | Not yet exercised | Not yet exercised | `cyberdeck stop` explicitly terminates the session |
| Native session persistence | Not yet exercised | Not yet exercised | Phase 1 preserves the live PTY for the broker lifetime; provider-native persistence is separate |

## Premium-model boundary

No Fable call belongs in setup validation or the Phase 1 acceptance pass. A top-level Fable start may be explicitly typed by a human, but delegated Fable must be rejected before any provider process starts.
