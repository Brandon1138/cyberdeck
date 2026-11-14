# Validation record

All commands ran in the isolated review checkout with Node **24.18.0** at `/Users/brandon/.local/share/mise/installs/node/24.18.0/bin`. Shell invocations used `rtk`; commands below show the child command for readability. No live provider was invoked.

| Check | Result |
| --- | --- |
| `node node_modules/vitest/vitest.mjs run --maxWorkers=2` | **PASS: 281 files; 3,717 passed, 26 skipped, 3,743 total.** Final source, including the failure-settlement wake and uncertain-withdrawal guards. See `full-tests.txt`. |
| `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | PASS on final source. |
| `node node_modules/typescript/bin/tsc -p tsconfig.json` followed by `node scripts/copy-client-assets.mjs` | PASS; isolated build only. |
| `node node_modules/typescript/bin/tsc -p evals/tsconfig.json` | PASS on final source. |
| `node scripts/ci-native-preflight.mjs` | PASS: pnpm 11.5.0, tmux 3.6a, Neovim 0.12.2, zsh 5.9 and required native build tools. |
| `node --test tests/scripts/native-acceptance.test.mjs` | PASS: all 14 guard/packaging/preflight tests. This is not the disposable packed-broker acceptance run. |
| Offline Promptfoo and `validate-promptfoo-results.ts` | PASS: eight scripted scenarios, zero failures/errors on the final source. See `offline-evaluation.txt`; no model inference. |
| `pnpm audit --prod --audit-level=high` | PASS: no known vulnerabilities. Lockfile and dependencies unchanged. |
| `git diff --check` | PASS. |

The offline gate invoked `node node_modules/promptfoo/dist/src/entrypoint.js eval --no-cache --max-concurrency 1 --output results/offline.json` from `evals`, followed by `node --import tsx ../scripts/validate-promptfoo-results.ts results/offline.json offline-scripted 1`. `PROMPTFOO_CONFIG_DIR` was a fresh task-specific directory under `/private/tmp`, and telemetry/update checks were disabled. Direct invocation avoids pnpm's auto-install behavior with linked dependencies.

Two deterministic failing-before observations were captured during implementation:

- Retain/read/recover the same native idle receipt: `worker-turn-native-state.test.ts` expected `awaiting-input`, received `unknown` on the agreed base. Same test passes after preserving the fenced view.
- Queue input behind a pending screen completion, then reject its asynchronous durable commit: `worker-turn-engine.test.ts` expected a delivery-boundary notification, received none before the settlement fix. Same test passes after notifying the explicit failure, with the ordinal still reserved.

Intermediate failures were resolved rather than counted as successful validation: precise reason assertions replaced old generic `provider-busy` expectations; fixture waits were corrected to wait for journal outcomes; the failure notification was restricted to poisoned current captures after an existing screen-backlog test correctly rejected a premature normal boundary. A separate host-resource stall prevented Vitest workers from starting; subsequent capped-concurrency runs completed.

The 26 skipped tests remain skipped; no claim is made that they passed. Linux/distro CI, history secret scanning, disposable packed-broker acceptance, and live-provider validation were not run. No approval to activate changes is implied by these results.
