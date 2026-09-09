# Writable worker network boundary

Cyberdeck is semi-autonomous within a declared workspace and capability envelope. Routine file
edits and commands do not require operator prompts. Authentication, unknown trust/security
dialogs and operations outside that envelope remain operator-owned boundaries.

The ordinary Docker bridge alone does not contain workers: OrbStack's `host.docker.internal`
alias can reach services bound to macOS localhost. Private mounts and dropped capabilities do
not close that path. Writable guests therefore use the following additional boundary.

## Enforced paths

| Path | Policy |
| --- | --- |
| Guest loopback | Permitted for processes within that worker only |
| Cyberdeck reporting gateway | Exact pinned OrbStack host IP and broker-assigned TCP port; existing bearer grant, generation and worker scope checks |
| HTTPS proxy | Exact pinned host IP and broker-assigned TCP port; CONNECT only, port 443 only |
| Provider/auth destinations | Exact `api.anthropic.com`, `chatgpt.com`, `api.openai.com`, `auth.openai.com`; public IPv4 DNS answers only, numeric connection pinned after validation |
| Host aliases, host routes, arbitrary host services | Denied outside the two explicit broker endpoints |
| Other workers, LAN/private/link-local/metadata networks | Denied |
| Direct Internet and external DNS | Denied; provider DNS resolution belongs to the proxy |
| Non-loopback IPv6 | Denied |
| Package registries and arbitrary websites | Outside this minimal profile; dependencies must be available as declared local inputs/cache |

The proxy rejects userinfo, alternate ports, IP literals, suffix/wildcard hosts, plaintext HTTP,
and private/mixed DNS answers. Redirects inside TLS do not widen the boundary: a new destination
requires another independently checked CONNECT. TLS is passed through without interception;
provider certificates remain validated by the client. No credentials, request bodies or URLs
are logged by the proxy. Unknown destinations fail rather than falling back to direct egress.

## Activation and lifetime

The broker requires the pinned image's network feature label for writable preparation. It resolves
the OrbStack host alias using a credential-free helper and pins that address in `/etc/hosts`.
It writes a fresh nonce to the read-only credential mount and removes any old readiness marker.
The trusted guest launcher waits for that nonce before provider/authentication code executes.

A separate `--rm` helper uses the same pinned image, shares only the worker's network namespace,
and holds only `NET_ADMIN`. It has no credential/workspace mounts or Docker socket. It sets INPUT,
OUTPUT and FORWARD policies to DROP for IPv4 and IPv6 before flushing rules, then installs the
two exact IPv4 TCP exceptions, guest loopback and inbound established/related replies. No general
established OUTPUT rule preserves sockets from before activation. The helper exits before the
broker writes the matching readiness nonce. Helper failure stops the guest without opening the gate.

The worker retains UID 1000, `cap-drop=ALL`, `no-new-privileges`, read-only root, resource limits,
and its three scoped mounts. Its effective, permitted, inheritable, ambient and bounding capability
sets are zero. It cannot replace the gate, change routing/firewall rules or attach another network.
Preparation and firewall installation repeat on resume; host and read-only execution paths retain
their existing policies. Broker shutdown closes the proxy and stops its workers.

## Verification

`scripts/prove-worker-network.ts <image>` uses the production executor and reporting gateway with
two credential-free writable guests. It probes aliases, numeric host/bridge addresses, localhost,
cross-worker sockets, private/metadata addresses, direct Internet and IPv6. Positive checks require
report readiness and own-worker reporting, plus certificate-validated TLS responses from all four
allowed hosts. Another worker's report is rejected. Guests also demonstrate workspace writes,
denied root writes, inaccessible host credentials/socket and inability to change firewall policy.
All fixture containers are removed after evidence collection.

Deterministic tests cover exact authority matching, public-address policy, mixed/rebound DNS,
plain HTTP refusal, image/proxy requirements, stale readiness removal and helper failure.
`scripts/verify-canary-privacy.ts` runs actual canary metadata through the existing Sentry SDK and
closed serializer with local interception. This proves privacy, not remote indexing.
