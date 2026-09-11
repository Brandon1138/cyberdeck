# Linux worker boundary

Build only this directory; the macOS root package and host configuration never enter the build context.

```sh
rtk docker --context orbstack build --pull=false -t cyberdeck-worker:20260905 infra/worker
rtk docker --context orbstack image inspect cyberdeck-worker:20260905
```

Base: Node 24.18.0 bookworm slim, digest in Dockerfile. Provider CLI pins: Claude 2.1.261, Codex 0.153.4. Runtime must resolve the built image's content-addressed ID, never launch a mutable tag. OS package versions are recorded in build evidence; reproducible apt snapshot pinning remains required before a production image is claimed reproducible.

The credential adapter accepts selected API keys or explicit Claude/Codex subscription sources; see [subscription workers](../../docs/setup/subscription-workers.md). No host home, Keychain, SSH agent, full account config or ambient MCP server is copied. The host login owns subscription refresh and each guest receives only an access snapshot. In-guest refresh and custom endpoint/CA/proxy configuration remain unsupported; missing support fails preflight, never runs on host. Provider login/model calls require their own live evidence.

Each worker owns its independent clone, private state and credentials staging directory. Secrets are read at guest launch, not serialized into Docker arguments/environment or durable execution records. Reporting uses a report-only authenticated endpoint; no unrestricted broker or Docker socket crosses the boundary. `report.mjs` takes one event JSON on stdin; MCP protocol adaptation remains to be wired.
