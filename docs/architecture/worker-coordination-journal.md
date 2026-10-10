# Worker coordination journal recovery

`orchestration/worker-coordination-v1.jsonl` is the authority log for leases, worker
reports, checkpoints, controller liveness, directed handoffs, audits, and mutation
receipts. Each mutation commits as one fsynced, newline-terminated transaction.

Replay streams complete records rather than reading the whole journal into a
string. This permits journals larger than Node's string limit. An unterminated
final fragment remains ignored as a torn write; committed blank, malformed,
unsupported-version, and duplicate-transaction records still fail closed.

At startup and after appends, the store considers a lossless checkpoint once the
journal reaches 64 MiB. It validates the source, then writes a private temporary
journal that keeps the first and latest snapshot of each subject, event,
checkpoint, liveness entry, and handoff. Keeping first appearances preserves
replay ordering. Every transaction ID, audit, and mutation receipt is retained.
The existing schema and authority path remain unchanged.

A checkpoint is installed only when it saves more than 25 percent. The original
journal is hard-linked to a unique adjacent `.archive` file and the directory is
fsynced before the temporary journal replaces the authority path atomically.
The replacement is fsynced through its file and parent directory. Appends and
checkpointing share one queue, and a detected external source change aborts the
checkpoint. Archives are history, not replay inputs.

Every append and load/checkpoint also holds SQLite's cross-process writer lock
on an adjacent private `.lock.sqlite` file. This covers opening an append
descriptor through fsync/close, and checkpoint validation through replacement.
A second process waits asynchronously, so a write cannot be acknowledged on an
inode that a concurrent checkpoint has retired. The OS releases the lock on
process death, including SIGKILL; the persistent lock file is never unlinked to
reclaim ownership. No authority data is stored in it.

Checkpoint failure is reported but does not turn an already-fsynced mutation
into a failed RPC. A failed replacement leaves the original authority intact;
a failed directory sync after replacement leaves an equivalent checkpoint and
its original archive. Retry thresholds grow with retained history so an
irreducible journal is not repeatedly rewritten on each append.

Audit and idempotency history deliberately have no expiry here. This change
removes the whole-file string ceiling and redundant budget observation checks;
it does not impose a lifetime disk or replay-projection memory bound. Expiring
receipts or deleting archives requires a separate retention contract.

Budget polling and update callbacks share a scheduler. Scheduled checks recheck
the last refresh time and in-flight work before starting another measurement,
preventing periodic checks from racing observation-triggered follow-up timers.
Explicit refreshes and durable soft/hard enforcement retain their behavior.
