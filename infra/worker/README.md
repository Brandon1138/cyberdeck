# Linux worker boundary

Build only this directory; the macOS root package and host configuration never enter the build context.

```sh
rtk docker --context orbstack build --pull=false -t cyberdeck-worker:20260905 infra/worker
rtk docker --context orbstack image inspect cyberdeck-worker:20260905
```

Base: Node 24.18.0 bookworm slim, digest in Dockerfile. Provider CLI pins: Claude 2.1.261, Codex 0.153.4. Runtime must resolve the built image's content-addressed ID, never launch a mutable tag. OS package versions are recorded in build evidence; reproducible apt snapshot pinning remains required before a production image is claimed reproducible.

The initial credential adapter accepts selected API keys only. No host home, Keychain, SSH agent, account config or ambient MCP server is copied. Subscription/OAuth refresh and custom endpoint/CA/proxy configuration are not supported by this adapter yet; missing support must fail preflight, never run on host. Provider login/model calls remain unproved until explicitly budgeted live runs.

Each worker owns its independent clone, private state and credentials staging directory. Secrets are read at guest launch, not serialized into Docker arguments/environment or durable execution records. Reporting uses a report-only authenticated endpoint; no unrestricted broker or Docker socket crosses the boundary. `report.mjs` takes one event JSON on stdin; MCP protocol adaptation remains to be wired.
