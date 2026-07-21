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

## Capability ledger after live acceptance

An observed capability is something demonstrated by the native runtime or Cyberdeck in this environment. A desired Cyberdeck capability is a product requirement and is not evidence that the underlying runtime has already demonstrated it.

| Capability | Codex observation | Claude observation | Desired Cyberdeck capability |
| --- | --- | --- | --- |
| Interactive start | Verified with Codex 0.144.6 in a broker-owned PTY | Native Claude 2.1.214 UI started and attached despite the status command reporting logged out | Start only with an explicit provider |
| Detach | Verified with `Ctrl-]`; the same PID continued while detached | Verified mechanically before any prompt was sent | Detach the view without stopping the provider |
| Reattach | Verified; the existing screen and completed output replayed | Verified mechanically before any prompt was sent | Reattach to the same broker-owned PTY |
| Steering | Verified for a top-level session and a delegated session | Not exercised because the native default shown by Claude was Fable | A controller can send input after attachment |
| Cancellation | Verified by stopping both Codex sessions and the Claude session, then checking their PIDs were gone | Verified mechanically with `cyberdeck stop` | `cyberdeck stop` explicitly terminates the session |
| Native session persistence | The same Codex PID completed a read-only response after the view detached | Not verified; no Claude model call was made | Phase 1 preserves the live PTY for the broker lifetime; provider-native persistence is separate |

## Premium-model boundary

No Fable call belongs in setup validation or the Phase 1 acceptance pass. A top-level Fable start may be explicitly typed by a human, but delegated Fable must be rejected before any provider process starts.

The installed Claude runtime displayed `Fable 5 with high effort` when launched without a model flag. Acceptance detached immediately and sent no prompt, so it made no Fable call. This conflicts with the plan's assumption that the configured native default would be an ordinary model. The broker did not substitute a model automatically.

## Version drift since this capture

Everything above is the 2026-07-20 capture and is left unchanged. Later read-only probes observed
these runtimes updating themselves, with no update command issued by Cyberdeck:

| Runtime | 2026-07-20 (this baseline) | 2026-07-21 (B1 capture) | 2026-07-21 (B5 acceptance) |
| --- | --- | --- | --- |
| `claude` | 2.1.214 | 2.1.215 | **2.1.216** |
| `agent` | 2026.07.16-899851b | 2026.07.17-3e2a980 | 2026.07.17-3e2a980 |
| `agy` | 1.1.4 | 1.1.4 → 1.1.5 mid-capture | 1.1.5 |
| `codex` | 0.144.6 | — | 0.144.6 |

Any capability recorded as `metadata-observed` is therefore a statement about a specific binary on a
specific date, not a durable property. Re-probe rather than trusting these indefinitely. See
[integrated-acceptance.md](integrated-acceptance.md) for the graded evidence categories.
