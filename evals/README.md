# Worker infrastructure evaluations

Promptfoo 0.122.2 is an isolated development dependency. It is excluded from Cyberdeck's runtime
package and ordinary installation. Use Node 24.18.0 and pnpm 11.5.0.

```sh
cd /Users/brandon/code/personal/cyberdeck/worktrees/worker-infrastructure
rtk pnpm --dir evals install --frozen-lockfile
rtk pnpm --dir evals run eval:offline
```

The custom provider starts a separate actual BrokerServer, SessionRegistry and instruction queue,
using unique state, socket, broker identity, fixture workspace and scripted Node provider processes.
It has no Fleet/nvim surface. Promptfoo telemetry and update checks are disabled; no model or judge
is invoked. Reports remain local. The suite validator requires exactly all eight scenarios; empty,
skipped, missing-evidence, malformed, duplicate or harness-error results fail. Critical assertions
are tested with deliberately failed and omitted checks. Agent claims are compared against separately
hashed host filesystem facts. Promptfoo's default zero token/cost aggregates are not measurements;
the evidence envelope records unmeasured spend as null.

`results/offline.json` is the Promptfoo report. Each row includes a private evidence path with
`facts.json` and `evidence.json`; failed attempts are retained. The dirty-tree fixture uses a real
private clone with selected tracked and untracked input. The phantom-turn fixture delays a durable
native-turn receipt while the next instruction enters the actual queue. Handoff/fencing and gateway
scope scenarios invoke the canonical services, including operator RPC. Sink failure is injected
after durable local activity writes.

**Proof limits:** these are offline scripted evaluations, not live agent behaviour. Timeout checks
stop a real host fixture process and separately exercise scheduler release. OOM and cross-worker
mount checks use an explicitly scripted Engine behind the production OrbStack adapter; they do not
prove kernel OOM or guest filesystem isolation. A live cross-worker run requires separate
host-verified guest-access evidence. The suite must never be relabelled as live-container evidence.
Production native tool collection/attribution, approved provider/model/total spend ceiling and a
container-capable live harness are still required before a live baseline or default rollout.
`runScenario(..., "live-container")` currently refuses explicitly. No paid defaults or model judge
are configured.

To turn an incident into a regression: select the local run and source event IDs, preserve/hash the
original evidence, copy only a sanitized minimal fixture, record provider/version and source
provenance, demonstrate the failure against an independent invariant, fix it, and retain both
negative grader tests and the scenario. Never use worker completion prose as fixture ground truth.
