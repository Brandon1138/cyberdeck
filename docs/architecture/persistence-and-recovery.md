# Persistence, recovery, and structured artifacts

A3 makes bounded control-plane jobs durable. It does not make provider PTYs durable: a session is a
broker-owned live process, and broker death ends that ownership. Recovery never treats a PID from
old state as proof that a provider is still running.

## On-disk layout

Under the configured Cyberdeck state directory (injectable in tests):

```text
events.jsonl                         diagnostic broker/session/job events
control-plane/jobs.jsonl             append-only validated job-state snapshots
control-plane/leases.jsonl           append-only validated lease-state snapshots
artifacts/metadata/<artifact-id>.json validated artifact descriptor and logical kind
artifacts/sha256/<hex-digest>         content-addressed bytes
```

`jobs.jsonl` is the source of truth for job reconstruction. Each newline-terminated record carries
schema version 1, a unique persistence event UUID, a persistence timestamp, and the complete state
needed to rebuild one job: immutable request, lifecycle/result, idempotency key, lineage,
provider-reported usage when known, and report-back state. Writes are schema-validated, appended,
and fsynced before the control plane reports the corresponding mutation as complete. Later records
for a job supersede earlier ones during deterministic replay; event order and older provenance stay
in the file.

The reader strips unknown fields at the current schema version. Any unsupported version fails with
`SCHEMA_VERSION_UNSUPPORTED`. Invalid JSON, invalid records, blank records, or duplicate event IDs
before the end of history fail closed. A crash may leave an unterminated final JSONL fragment; only
that final fragment is ignored. No earlier corruption is skipped and no compaction is currently
performed.

## Restart state mapping

| Stored job state | Recovered job state | Automatic action |
| --- | --- | --- |
| `queued` | `interrupted` | none |
| `dispatched` | `interrupted` | none |
| `running` | `interrupted` | none |
| `interrupted` | unchanged | none |
| `settled` | unchanged, including exact result/usage/report-back | none |

The interruption reason records that previous runtime ownership is unverifiable and explicit
recovery is required. Recovery never dispatches, retries, resumes, routes, or delivers report-back.
The recovered idempotency index prevents a repeated submission key from creating or dispatching a
duplicate job. A pending or failed report-back remains pending or failed until a caller explicitly
acknowledges or retries it. Repeating recovery is idempotent.

An omitted Claude model is persisted as omitted. Recovery does not reinterpret omission as a safe
model choice and does not relaunch it; every future live Claude boundary must still require an
operator-verified explicit ordinary non-Fable model.

## Artifact guarantees

`ArtifactStore.write` accepts a logical name, optional logical kind, media type, bytes, and optional
producing job UUID. Logical names may not contain path separators or traversal components. They are
never used as filesystem paths. The store assigns a collision-safe artifact UUID and records an
`ArtifactDescriptor` containing SHA-256 digest, exact byte length, media type, creation time,
producing job, and an absolute file reference. Content is addressed by digest, so identical bytes
share a content file while retaining distinct artifact descriptors.

Content and metadata use write-temp, file fsync, atomic rename, and directory fsync. Reads validate
the artifact UUID, metadata schema/version, expected content path, regular-file type, configured
size limit, byte length, and digest. Missing, corrupt, oversized, invalid-id, path-escape, and
unresolved-external-reference conditions are distinct errors. Inline references are bounded and
validated locally. External references are never fetched by the local store. The metadata API has
no credential or arbitrary-secret fields; unstructured terminal replay is never promoted to an
artifact unless an adapter explicitly submits validated content.

Lease replay uses the same fail-closed JSONL rules. A held, unexpired lease cannot prove that its
old owner still controls the worktree, so startup persists it as an orphan and blocks reuse until
explicit operator remediation. Expired leases become released. Recovery never removes Git
worktrees or directories; see `app-server-and-worktree-leases.md` for fencing and remediation.
