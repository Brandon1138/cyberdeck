# Host-owned subscription refresh preflight

Provider metadata inspected read-only on 2026-09-16:

- `codex --version`: **codex-cli 0.154.0**.
- `codex app-server generate-ts --out <temporary-directory>` emitted
  `v2/GetAccountParams.ts`, with `refreshToken?: boolean`. Its description states:
  “When `true`, requests a proactive token refresh before returning. In managed auth mode
  this triggers the normal refresh-token flow. In external auth mode this flag is ignored.”
  `ClientRequest.ts` binds these parameters to `account/read`.
- `v2/GetAccountResponse.ts` returns `account` and `requiresOpenaiAuth`; `Account.ts`
  distinguishes `chatgpt` from `apiKey` and `amazonBedrock`.
- `claude --version`: **2.1.261 (Claude Code)**. `claude auth --help` lists login,
  logout and status. `claude setup-token --help` describes long-lived subscription token
  setup. No noninteractive renewal command is advertised by these installed interfaces.

No account/read, login, credential refresh, remote request or credential mutation was executed
to obtain this evidence. Generated protocol support is not proof that this installation has
completed a refresh. A later live proof must use the admitted host adapter and preserve any failure.

## Composition contract

Create one `SubscriptionRefreshCoordinator` for the installation. Its `prepare()` receives
provider, configured authentication source, execution identity, launch/wake phase, minimum
lifetime and optional caller cancellation signal. It returns ready plus a **host-private**
access-only credential snapshot, waiting-capacity, login-intervention with an enumerated reason,
or cancelled. Never serialize the ready credential into public health, events or logs.
`status(sourceId)` returns metadata only. The broker's authoritative attempt/lease checks still
precede this preflight; the coordinator does not grant authority or modify a worker queue.

The optional final `BrokerContainerContexts` constructor parameter invokes this preflight
before issuing a reporting token, cloning a workspace or staging credentials. Non-ready results
throw `SubscriptionPreflightError` carrying only sanitized status. Preserve the queued launch
on waiting-capacity or login-intervention; do not convert them into task completion or fallback.
Every resumed runtime must repeat preflight. A parked runtime has no durable promise that the
previous access snapshot will remain valid; changed/expired host credentials are reread on wake.

Inject `AdmittedSubscriptionRefreshPort.refreshCodex({identity, sourceId, codexHome,
timeoutMs:30000, maxOutputBytes:65536})`. It returns refreshed, waiting-capacity, or intervention.
The composition root must reserve helper memory/CPU/PIDs under the same 8 GiB installation
budget, enforce deadlines/output bounds, and confirm helper termination before releasing its
reservation. This implementation deliberately has **no default spawn or unaccounted subprocess
path**. A single caller's cancellation does not abort a shared refresh used by other workers;
the admitted host helper keeps its own bounded lifetime and cancellation/cleanup responsibility.

For an admitted host session, `codexRefreshCommand()` supplies the existing repository's
file-backed, forced-ChatGPT command profile, `CODEX_HOME` bound to the original auth.json
directory, and an allowlist of PATH/HOME/TMPDIR. Ambient API keys and routing variables are not
forwarded. `refreshCodexAccount(session, expectedHome)` performs initialize, checks Codex
0.154.0 and the canonical home, notifies initialized, verifies account/read without refresh
reports ChatGPT, then calls account/read with refreshToken true. It never starts a turn, invokes
login, changes account configuration or sends a refresh token through RPC. The root owns the
bounded stdio transport and confirmed shutdown. All protocol/parser/provider errors must remain
sanitized; raw stdout/stderr/account metadata must not escape through the transport's diagnostics.

## Boundaries and intervention

Only a private, host-owned **auth.json** with managed `auth_mode: chatgpt` and an existing refresh
token is refreshable. External `chatgptAuthTokens`, differently named snapshots, and missing
refresh authority remain explicit refresh-unsupported intervention. Canonical source paths
deduplicate concurrent broker refreshes. The original file is reread afterward; sufficient
lifetime (including the existing 60-second margin) and the same account are mandatory. Guests
still receive `chatgptAuthTokens` with an empty refresh_token and no API billing fallback.

Failed source versions are not automatically refreshed again on ordinary queue polls. Operator
`retry(sourceId)` or changed host credentials can permit another attempt; a ready renewed source
clears its failure. Account changes require explicit retry acknowledgment within the coordinator's
lifetime. These guards are in-memory; startup must rerun preflight, and root policy should retain
intervention if repeated refresh across restarts would be inappropriate. Serialization covers this
installation's coordinator, not independent native provider CLIs or a second broker.

Claude Keychain credentials have expiresAt and are checked normally. On expiry, the result is
renewal-required; the operator can use the provider's supported subscription login/setup workflow.
There is no guessed OAuth URL or automation of a login window. An opaque setup-token file exposes
no trustworthy expiry metadata, so the managed preflight reports expiry-unknown. The low-level
legacy resolver remains compatible with explicit setup-token files; enabling this preflight makes
the stricter lifetime requirement visible instead of inventing a TTL.

The implementation has mocked concurrency, expiry/wake, capacity-wait, source/account mismatch,
access-only export and secret-redaction evidence. Actual rotation, revocation detection during a
running guest, cross-process refresh coordination and provider-supported unattended Claude renewal
remain unverified or unsupported. Access-only guests cannot repair revoked credentials themselves.
