# Worker operational rollout — 2026-09-11

## Status

The candidate supports subscription-authenticated Claude/Codex ordinary workers in dedicated Docker containers on OrbStack. These containers share OrbStack's Linux VM; they are not one microVM per worker. Sentry's active configuration is unchanged.

Activation on the operator's main broker remains pending: active workers and orchestrators are using it, and its restart stops their processes. The replacement configuration is prepared privately but has not been installed. Existing host sessions are not migrated. New unsupported work must request an explicit host executor; container requests never fall back.

## Candidate and proof

Baseline candidate: `dde764a77f50c669b92638a4e6df3950af967898`. Resume readiness fix: `26289ec`;
dispatch/durability fixes: `28193f5`
(the baseline completed against its original clean candidate; resume was verified separately).
Final worker image: `sha256:38605831c783da47710a5ebd9649f95002bb8f489a93dcc74a662756ab3ecc8f`.
Pinned image tools: Claude 2.1.261, Codex 0.153.4. Runtime and evaluations use Node 24.18.0.

| Requirement | Evidence | Boundary |
| --- | --- | --- |
| Source/type safety | Production and eval TypeScript checks; production build | Local candidate |
| Regressions | Final runtime: 189 test files / 2,218 tests passed; production and eval typechecks passed; CI green | Local Node 24 and GitHub verification of `28193f5` |
| Offline Promptfoo | `evals/results/rollout-offline.json`, 8/8 with strict validation | Scripted host harness |
| Container Promptfoo | `evals/results/rollout-container.json`, 8/8 with strict validation | Final image; real kernel resource limits and isolation with scripted guests |
| Failed acquisition retirement | `cyberdeck-rollout-retirement-66XYEz/proof.json` | Real OrbStack confirms absence; source preserved; staged credentials removed; idempotent retirement |
| Default Codex execution | `cyberdeck-codex-subscription-canary-qSgHC8/canary.json` | Isolated production broker; executor omitted; workspace edit and offline npm dependency verified; native tools and turn captured |
| Default Claude execution | `cyberdeck-claude-subscription-canary-ypFM64/canary.json` | Isolated production broker; executor omitted; authenticated successful command and native turn captured |
| Live routine edits and reporting | Claude `cyberdeck-eval-ukFOv8/evidence.json`; Codex `cyberdeck-eval-NRT9Kq/evidence.json` | Correct edit, unrelated files preserved, accepted structured gateway report, native command evidence |
| Writable network containment | `cyberdeck-network-proof-sdp5QK` | Final image; host/private/sibling/direct-Internet probes denied; provider routes and own reports accepted; host sentinel hits zero; helper containers removed |
| Authenticated resume | Codex `cyberdeck-live-resume-U7FIVz/proof.json`; Claude `cyberdeck-live-resume-iO8tPv/proof.json` | Final image and readiness fix: immediate queued instruction, same execution, generation 2, renewed network nonce, native tools, accepted report and exactly one additional completion |
| Packaging and dependency audit | `cyberdeck-pack-proof-qtxvpv`, 966 package entries, eval artifacts excluded; production audit clean | Fresh package install; Gitleaks clean through the runtime fixes |

Named temporary evidence directories are under `/private/var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/`; they may expire. The isolated production acceptance broker used `/tmp/cd-rollout-acceptance-5SI1FU`. Both canaries were retired, their containers removed, and that broker shut down.

## Operational changes

- Retirement accepts a daemon-confirmed absent container and writes a hashed absence manifest. It never substitutes the original source directory for a private clone, and retains missing-log/context status explicitly. Transport/ownership failures still refuse retirement.
- Resumed containers hold queued input until the provider reports an idle composer. History and MCP startup never count as a new turn. This fixes a live reproduction where immediate resume input was lost and startup created a false terminal-derived completion.
- Container instructions use explicit paste framing followed by the provider's existing native Enter key. Host input bytes remain unchanged.
- Automatically approved writable Claude containers allow routine Bash/file/search/report tools. Prompt-mode and read-only requests retain their policies. The container supplies the filesystem and network boundary; unknown tools, login and trust prompts retain their existing controls.
- The guest MCP helper reads the reporting URL from its private read-only mount, because Codex filters the environment of MCP subprocesses. It forwards structured facts through the existing gateway and lease checks.
- The live harness uses the production native transcript/capture path, fixture-scoped trust and the writable Codex profile. It waits for a native warm-up turn and an idle composer before sending scenario instructions.

## Baseline results

The initial clean-candidate full baseline completed 48 cases (eight scenarios, three repetitions,
two subscription providers): **Codex gpt-5.6-luna 21/24; Claude haiku 15/24**. Full reports remain
local in `evals/results/baseline-2026-09-11T09-09-52.860Z/`. The committed
[sanitized result summary](worker-baseline-20260911.json) retains every row, metric, failure and
report/artifact hash without private paths or transcripts.

Claude's three `phantom-turn` failures assigned two instructions the same ordinal before the TUI
repainted. Its three `sentry-outage` failures skipped `instruction.submitted` when a native completion
advanced straight from rendered to completed. The fixes reserve a rendered container instruction's
turn until settlement and emit every reached lifecycle transition. Graders are unchanged. Targeted
three-repetition reruns passed **Claude 6/6 and Codex 6/6** on clean commit `28193f5`.
The [focused confirmation](worker-focused-confirmation-20260911.json) preserves checks, metrics and
report hashes. Providers ran concurrently for correctness confirmation; these timings are not a
latency comparison. This is a 12-case subset, not a replacement full baseline.

Both providers also failed all three OOM cases, described below. The initial baseline is preserved;
subsequent focused results do not rewrite it as a passing full suite.

## Evaluation interpretation

`eval:baseline` runs the real Promptfoo suite three times per scenario for each explicitly configured provider. Each invocation preserves separate provider reports and summaries. Reports include independent correctness checks, elapsed scenario duration, native tool invocation/result counts, classified failures and unclassified tool results. Zero classified failures is not proof that every tool succeeded. Subscription cost remains unmeasured, not zero.

This is a repeated benchmark, not automatic correctness grading of every arbitrary production task. Production container activity remains recorded per worker; benchmark results apply only to the named provider/model/image/scenarios. Baseline failures must remain visible.

The whole-container OOM rubric remains strict. Codex refused the unbounded allocation command.
Claude ran the allocator and reported child-process exit 137 while its worker container survived.
Neither outcome proves the whole-container kill required by this scenario. Each failed row reports
`GUEST_NOT_OOM_KILLED` and retains its failure codes; the harness does not claim successful cleanup
or capacity evidence when it exits early. The separate scripted
container suite verifies that lifecycle; these live cases remain errors rather than being converted
to passes. Revisit the fault-injection design separately before using its pass rate to rank models.

## Activation and rollback

After the broker's active sessions have finished, install/build the reviewed candidate at the operator's usual checkout and preserve all other configuration fields while setting:

```json
{
  "workerExecution": {
    "defaultExecutor": "orbstack-container",
    "hostProfile": "host-compatible",
    "containerProfile": "ordinary"
  },
  "containerRuntime": {
    "image": "sha256:38605831c783da47710a5ebd9649f95002bb8f489a93dcc74a662756ab3ecc8f",
    "codexWorkspaceIsolation": "container"
  }
}
```

This is a merge fragment, not a replacement config: keep the existing endpoint, authentication, resource limits and Sentry settings. Keep the two-slot capacity already checked against this VM. Restart the broker, verify `execution-health` is reachable and the retained failures clear, then rerun both default-routing subscription canaries:

```sh
rtk pnpm exec tsx scripts/subscription-canary.ts codex gpt-5.6-luna --writable --trust-fixture --default-executor
rtk pnpm exec tsx scripts/subscription-canary.ts claude haiku --trust-fixture --default-executor
```

The flag requires a configured container default, omits an explicit executor and verifies the returned
execution is container-backed. The canary stops its worker and retains evidence; retire the stopped
canary through `session.delete` after inspection. A restart stops active processes, so do not use it as a hot reload.

Cursor, Antigravity, Scout, native macOS/iOS tooling, Docker-dependent work and unsupported workspace/image modes require explicit host execution or a separate supported profile. The worker never receives the host Docker socket. Rollback sets the default executor back to `host` and restarts in a safe window; it does not migrate existing sessions.
