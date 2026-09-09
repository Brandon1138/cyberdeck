# Worker execution acceptance

See [worker-infrastructure-acceptance.md](worker-infrastructure-acceptance.md) for current evidence
and operator gates, and [worker-execution.md](../architecture/worker-execution.md) for the execution
contract and support matrix. Earlier per-PR checkpoints are retained in Git history.

Isolation is opt-in. Authenticated Claude/Codex canaries and live evaluation, remote Sentry
activation, host-exception acceptance and an operator-controlled broker restart precede rollout.
