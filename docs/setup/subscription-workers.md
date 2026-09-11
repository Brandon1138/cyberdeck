# Claude and Codex subscription workers

The broker supports explicit subscription authentication for OrbStack workers. No API credits,
API key or dollar ceiling is needed for this mode. Subscription usage limits still apply.
Cursor and Antigravity container support is unchanged.

In `~/Library/Application Support/Cyberdeck/config.json`, keep the existing container image and
resource settings and select authentication sources:

```json
{
  "containerRuntime": {
    "endpoint": "unix:///Users/YOU/.orbstack/run/docker.sock",
    "image": "sha256:<the locally built worker image ID>",
    "authentication": {
      "claude": { "kind": "claude-subscription", "keychainService": "Claude Code-credentials" },
      "codex": { "kind": "codex-subscription", "authFile": "/Users/YOU/.codex/auth.json" }
    }
  }
}
```

This does not change `workerExecution.defaultExecutor`. Select `--executor orbstack-container`
for a worker. Build the image from `infra/worker` and restart the broker after changing its config.
The image must include `auth.mjs`. Writable launches additionally require the
`cyberdeck.network-boundary=1` image label and firewall helper; older images fail closed.

Claude can instead use `{ "kind": "claude-subscription", "tokenFile": "/absolute/private/token" }`.
Generate that long-lived subscription token with `claude setup-token`, then save it privately;
do not paste it into commands, source files or chat. Select exactly one source. The broker reads
only the named Keychain item or file, never scans the Keychain or copies a provider home.
Files must be regular, owned by the broker user, mode `0600`, and not symlinks.

## Credential lifecycle

The host provider login owns refresh. At every launch/resume the broker reads a fresh access-only
snapshot. Claude receives `CLAUDE_CODE_OAUTH_TOKEN`; Codex receives native `chatgptAuthTokens`
authentication in its private home with an empty refresh token and no API key. Neither guest
receives the host refresh token, Keychain, host home, or permission to write back to the source.
Concurrent workers therefore cannot rotate or invalidate the host's refresh token.

Known-expiry snapshots must outlive the configured attempt timeout plus one minute, otherwise
preparation fails with `CONTAINER_SUBSCRIPTION_LOGIN_EXPIRED`. Refresh/sign in using the host CLI
and retry or resume. Long-lived Claude token files have no locally available expiry claim; the
provider reports rejection when expired or revoked. Workers do not refresh tokens mid-attempt;
lease extensions do not extend token validity. Authentication failure never selects API billing.

Claude's new private home gets account onboarding marked complete because subscription auth was
explicitly selected. This does not accept workspace trust or tool permissions. Existing repository
trust grants and modal prompts retain their policy.

Cyberdeck is semi-autonomous. Routine edits, commands and dependency installation within a
worker's assigned workspace and capability envelope should run without interactive approvals.
Authentication/login, unknown trust or security prompts, and operations outside that envelope
remain operator-owned boundaries. Do not implement this by automatically answering unknown dialogs.

The explicit `containerRuntime.codexWorkspaceIsolation` setting defaults to `"native"`.
The local implementation of `"container"` changes only writable OrbStack Codex launch/resume
arguments to `-s danger-full-access -a never`. Host Codex and Claude arguments are unchanged.
Read-only Codex retains `-s read-only`, its original approval mode, and
`--enable use_legacy_landlock` to avoid unsupported nested bwrap namespaces.

Writable containers now receive a default-deny IPv4/IPv6 firewall before provider code starts.
Only the reporting gateway and an HTTPS CONNECT proxy are reachable outside the guest. The
proxy permits exact provider/auth hosts, validates public DNS answers, and pins the destination
address. Changing proxy environment variables cannot bypass the firewall. Host services, other
workers, private networks, direct Internet connections, and general DNS egress are blocked.
Read-only container networking and host execution are unchanged.

The firewall helper is a separate, short-lived trusted container with only `NET_ADMIN`, sharing
the target worker's network namespace. It has no credentials, host mounts, or Docker socket.
The worker remains UID 1000, has no capabilities, and cannot alter the rules. Every prepare/resume
removes the old activation marker; only successful firewall installation opens the launch gate.
See [network boundary](../architecture/worker-network-boundary.md) for the enforced paths and proof.

## Canary

```sh
rtk proxy node --import tsx scripts/subscription-canary.ts claude haiku
rtk proxy node --import tsx scripts/subscription-canary.ts codex gpt-5.6-luna
rtk proxy node --import tsx scripts/subscription-canary.ts codex gpt-5.6-luna --writable
```

Use models available to your subscription. Each command creates a clean disposable source repo
and starts one ordinary worker through the active broker, with an explicit container executor
(Claude workspace-write, Codex read-only).
Accept the provider's trust prompt for that created repository. The worker runs one `printf`
command; the script checks a matching native tool result and attributed successful turn, writes
private evidence, and stops the worker. Evidence remains available for inspection. It does not
change routing, enable API spending, or configure Sentry. An assistant saying “OK” after a failed
tool is not a passing canary.

`--writable` requires the explicit container-isolation opt-in. It additionally checks an actual
file edit and an offline local dependency installation. `--state <directory> --socket <path>`
targets an isolated instance of the production broker. `--trust-fixture` grants trust only to the
clean disposable repository the script just created, through the existing repository grant store.
It never answers an unknown security prompt. Retire the stopped session after inspecting evidence.

Sentry is the existing optional metadata sink. For remote verification, sample the named canary at
100%, match the evidence's event/trace/session IDs in Sentry, then restore normal sampling. Queue
drain alone does not prove remote indexing. Full provider suites, refresh during a running attempt,
and provider-version upgrades require their own evidence.

References: [Claude subscription tokens](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token),
[Codex authentication](https://developers.openai.com/codex/auth),
[worker execution](../architecture/worker-execution.md).

### Sentry connection privacy

Keep the project’s **Prevent Storing of IP Addresses** enabled and its narrow advanced
scrub rule **Remove Anything from `user.geo.**`**. The existing serializer also supplies
the constant unspecified IP `0.0.0.0`, preventing transport-IP geolocation before server
scrubbing. Live verification found project scrubbing alone insufficient. These settings
affect new telemetry; they do not rewrite historical events.

## Operational rollout and comparison baseline

See [the operational acceptance record](worker-operational-rollout.md) for the tested image,
default-routing evidence, failures, activation and rollback. Existing host workers are not migrated
when the default changes. Preserve Sentry settings during the configuration merge and restart only
in a safe window.

`evals` provides `eval:baseline <private-codex-config> <private-claude-config>` for three repetitions
of all scenarios per provider. This measures the benchmark workers; arbitrary production tasks are
not automatically correctness-graded. Full reports remain local and must not include credentials in
PR artifacts.
