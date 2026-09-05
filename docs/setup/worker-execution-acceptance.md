# Worker execution support and remaining gates

This candidate is opt-in. Existing host sessions and first-party host orchestrators retain their
launch behavior. The running operator broker has not been restarted or migrated. Ordinary-worker
default isolation is not enabled until the provider, activity, remote trace and live evaluation
gates pass and native/provider exceptions are accepted.

| Path | Candidate behavior | Evidence |
| --- | --- | --- |
| Worker session launch/resume | Durable executor identity; container failure cannot call host factory | Focused registry/schema tests |
| Container Claude/Codex PTY | Guest launch/config builder, private provider state, selected API-key file, scoped MCP | Argument/file fixtures; no authenticated model run |
| Container Cursor/Antigravity, Scout, images, extra writable roots, worker-created linked worktrees | Explicit unsupported refusal | Source/fixture coverage; no claimed Linux support |
| Job/app-server dispatch under required container policy | Explicit unsupported executor refusal | Dispatch policy tests |
| Host/native work | Explicit host profile; original permission flags | Host regression tests; no new native iOS run |
| Operator/peer handoff | Same worker execution; canonical authority transfer and stale token fencing | Real broker + OrbStack scripted proof |
| Stop | Guest inspection, force escalation during graceful stop; retries after control failure | OrbStack scripted proof + escalation tests |
| Startup reconciliation | Known guest writers stopped before new admission; unreachable resources retained | Actual isolated broker SIGKILL left a running guest; fresh recovery stopped/collected/removed it |
| Retirement | Confirm stop, collect/hash evidence, destroy only after verification; preserve clone | Service tests; exact-candidate integration remains |

Selected dirty input is supplied through `workspace.selectedInputs` (relative path, action,
SHA-256 and executable bit). Bytes are read from the declared source under verification. Omitted
dirty paths refuse launch; ignored files and symlink modifications are not silently copied.
Persisted workspaces mark `storage: independent-clone`. Broad host roots are never mounted.

Container authentication currently accepts an explicitly configured API-key file per provider;
OAuth refresh, custom endpoints, certificate/proxy configuration
have not passed provider runtime gates. Native transcript rebinding is implemented with confined
provider-owned bindings and explicit persisted resume IDs, but authenticated provider proof is pending. Host authentication does not establish container support.

Latest real broker/container scripted proof:
`/var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/cyberdeck-broker-container-proof-xTIuP9`.
Image `sha256:505299d994e338a099a4332b56b46dbf39feb9efbcb488799122dedec39c6a0b`, Node 24.18.0,
Claude 2.1.261, Codex 0.153.4. No model calls. Guest UID/resource/read-only/interactive resize/report,
primary-to-peer handoff, stale authority, store reopening and guest stop passed. Collection succeeded
and the owned container is absent. Earlier evidence remains retained. This predates subsequent
source edits and is not exact-final-commit acceptance.

Subsequent SIGKILL proof: `cyberdeck-broker-container-proof-2SLMpT`; subsequent real cgroup OOM proof:
`cyberdeck-broker-container-proof-RGQqdD`, under the same temporary root. The latter verified
OOMKilled=true and exit 137 using image
`sha256:596f6caf80f4e581392a3fcad8b7a652ec3569d6862e34b4c65e1e9b69c67374`.
Both owned containers were collected and removed. These remain scripted-provider proofs.

Subsequent generation-bound resume proof: `cyberdeck-broker-container-proof-8bfTTa` preserved the
same execution/container/workspace at generation 2 and verified resumed report-back. Real five-second
attempt expiry: `cyberdeck-broker-container-proof-12IhOQ` stopped the guest, recorded timeout, released
the slot and collected/removed the container. Both used image
`sha256:5d179eccc6bd197adbb6d0ca2928778e04716ce3ab4d6a3ae560fbe95227e413`. Guest provider versions
remain Claude 2.1.261 and Codex 0.153.4, without model calls. Earlier evidence remains preserved.

Queued launches are cancellable through the registry and `execution-cancel --session UUID`.
`execution-health` exposes connection, slots and durable records. Default attempt timeout is 60 minutes;
only acknowledged canonical lease renewal extends it. Shutdown closes admission before cancelling
pending starts. The periodic sweep only retires old failed acquisitions without registered sessions;
registered/resumable workers require explicit retirement.

Remaining integration gates include broader retained-failure policy, all crash boundaries,
initial/direct/in-progress and host-native tool capture, coordination activity, complete supported-provider
canaries and reviewable default rollout. No remote Sentry trace or live Promptfoo run exists yet. Missing
remote authorization/configuration and provider/model/spend values will be requested after independent
implementation is ready; those gaps do not count as passes.
