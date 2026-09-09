# Worker infrastructure evaluations

Promptfoo 0.122.2 is an isolated development dependency. It is excluded from Cyberdeck's runtime
package and ordinary installation. Use Node 24.18.0 and pnpm 11.5.0.

```sh
cd /Users/brandon/code/personal/cyberdeck
rtk pnpm --dir evals install --frozen-lockfile
rtk pnpm --dir evals run eval:offline      # scripted host provider, CI
rtk pnpm --dir evals run eval:container    # real OrbStack containers, scripted guest, no model
rtk pnpm --dir evals run eval:live         # real provider in containers; CYBERDECK_LIVE_EVAL_CONFIG required
```

Three modes share one provider (`providers/cyberdeck.ts`), one scenario catalog and one evidence
schema. The mode is recorded in every evidence row and the graders refuse a row that claims more
than its mode can prove.

| Mode | Broker | Worker | Proves | Cannot prove |
| --- | --- | --- | --- | --- |
| `offline-scripted` | real isolated broker, host executor | scripted host process | harness, assertions, queue/authority/scheduler behaviour | isolation, kernel limits, model behaviour |
| `container-scripted` | real isolated broker through the production `brokerExecutionRuntime` | scripted guest inside a real OrbStack container | private clones with selected inputs, gateway scope from inside the guest, real attempt-deadline stop, real cgroup OOM, cross-worker mount isolation, selective retirement | model behaviour, native tool capture |
| `live-container` | same as container | the real provider CLI and model | agent decisions, native command coverage, truthful reports | nothing more than three bounded repetitions can |

The custom provider starts a separate actual BrokerServer, SessionRegistry and instruction queue,
using unique state, socket, broker identity, fixture workspace and scripted Node provider processes.
It has no Fleet/nvim surface. Promptfoo telemetry and update checks are disabled; no model or judge
is invoked below live mode. Reports remain local. The suite validator requires exactly all eight
scenarios per repetition; empty, skipped, missing-evidence, malformed, duplicate or harness-error
results fail. Critical assertions are tested with deliberately failed and omitted checks. Agent
claims are compared against separately hashed host filesystem facts. Promptfoo's default zero
token/cost aggregates are not measurements; the evidence envelope records unmeasured spend as null.

## Container-scripted mode

The worker container runs the same scripted guest the host mode runs, staged into the worker's
private provider home, never into the workspace under review. Inside the container it also reports
through the real gateway with its real token, probes the gateway with forged authority, an operator
method and a foreign worker id, and probes the host socket, host home and sibling paths. Each
scenario's container-only checks (`scenarios/catalog.ts`, `containerChecks`) are required in both
container modes: the report arrived through the gateway, the guest probes were refused, the guest
was stopped by the real deadline path, the OOM was a real cgroup kill at the configured limit, and
the other worker is unavailable by host-verified mount facts. The timeout scenario hands the real
expiry path a clock already past the recorded deadline rather than waiting an hour; the guest stop,
the slot release and the durable timeout record are real.

Every container row carries the image digest that ran. Workers are retired through the production
path (stop, collect, destroy) and the fixture's broker labels are checked to be gone.

## Live mode and the trusted manual workflow

Live mode never has a default provider, model, credential or budget. It reads one JSON file named
by `CYBERDECK_LIVE_EVAL_CONFIG` (`harness/live-config.ts`): provider, model, optional effort,
absolute credential file path, `authorizedCeilingUsd`, repetitions (default three), optional image
digest, container cpus/memory, attempt timeout and per-scenario wall clock. The ceiling is written
into every evidence row; a live row without a positive ceiling, with a scripted provider, or with
scripted command coverage fails `live-evidence-invalid`. Command coverage in live mode is the
provider-native `tool.invocation` evidence the activity recorder captured for that broker; a run
with none is labelled `unavailable` and fails where command evidence is required.

`.github/workflows/infrastructure-live.yml` is `workflow_dispatch` only, runs on a self-hosted
trusted macOS runner with OrbStack, refuses a live run without a config path, keeps reports as a
workflow artifact and shares nothing automatically. Pull requests never reach it.

The live prompts (`scenarios/live-prompts.ts`) ask each worker for the same structured report the
graders read from the acknowledged worker report. They have not been exercised against a paid model
yet; the first authorized baseline calibrates them, and its stochastic outcomes are recorded, never
promoted to reliability proof from a single pass.

**Proof limits:** offline rows are scripted evaluations, not live agent behaviour. Offline OOM and
mount checks use an explicitly scripted Engine behind the production OrbStack adapter. Container
rows prove the boundary and the lifecycle with a scripted guest; they say nothing about what a model
would do. Only live rows carry agent decisions, and they carry them per repetition.

To turn an incident into a regression: select the local run and source event IDs, preserve/hash the
original evidence, copy only a sanitized minimal fixture, record provider/version and source
provenance, demonstrate the failure against an independent invariant, fix it, and retain both
negative grader tests and the scenario. Never use worker completion prose as fixture ground truth.
