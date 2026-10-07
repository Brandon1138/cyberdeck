# Review and merge handoff

Scope frozen at the operator's request to conserve weekly usage. This branch delivers
reviewable resource-management implementation and evidence, with incomplete operational
acceptance. Do not describe the 8 GiB / eight-worker upgrade as complete.

```sh
cd /private/tmp/cyberdeck-resource-managed-autonomy/artifacts/resource-managed-autonomy
```

Product source: `15e455d16c5fb1eb20dc6a59bb62b4ab74224065`; base:
`af8d19ecda9e16ece12c4b713e9867c66984920b`. Subsequent wrap-up contains evidence,
documentation and the exact Gitleaks false-positive fingerprint only. The branch is
`feat/resource-managed-autonomy`. The primary checkout and running installation are preserved.

## Verified

- 2,628 tests / 238 files; both TypeScript checks; build; eight offline Promptfoo scenarios;
  production dependency audit; whole-history scan with reviewed exact hash exception.
- Packed CLI inspection, fresh-prefix installation and isolated installed headless broker
  startup/status/shutdown. Exact package/hash/log provenance: `candidate-15e455d-checks.json`.
- Earlier clean `9dde8c7` PostgreSQL fixture: successful service/readiness/SQL assertions,
  scoped teardown, unchanged bracketed foreign inventory and reservation released. Its
  sampled conservative peak was about 5.82 GiB. Not final W10 or lifetime peak evidence.
- Synthetic Sentry receipt in authenticated Zen, with exact event/trace/source in
  `sentry-resource-probe.json`. Not final workload evidence.
- Independent scoped recovery/authority/evaluation reviews; identified P1 defects fixed
  and regression-tested, latest evaluator follow-up has no remaining scoped P0/P1.

## Required follow-up

`ACCEPTANCE.md` is the detailed matrix. Principal gates: native lifetime/simulator ownership
and real fixture/representative build tests; safe accounted image construction; actual
automatic evaluator container; three authenticated eight-worker W1 runs and fair two-family
service; W0–W10 matrix, parking/recovery and 24-hour soak; fresh workload Sentry receipt;
measured profile calibration; exact private configuration merge and activation/rollback.
No final worker/evaluator image or activation config identity exists yet. The real service
image and its proof configuration hashes are in `integration-service-proof.json`.

Native polling cannot prove full descendant/CoreSimulator lifetime. Reservations remain held
instead of releasing on an incomplete PID scan. Current accounting charges the whole VM as a
conservative upper bound and still needs residual calibration. Do not weaken either guard
to manufacture acceptance. No budget increase or two-active-worker substitute is approved.

Physical M4 mini acceptance awaits hardware and does not replace the MacBook gates. No live
activation or protected merge was performed. A merge decision must distinguish source landing
from operational completion and must inspect current PR checks and exact head first.

## Preserved unfinished work

`/private/tmp/cyberdeck-resource-worker-image` contains an uncommitted, untested assembler
draft with a known type error; not integrated. `/private/tmp/cyberdeck-admitted-subscription-refresh`
contains an uncomposed refresh leaf. Neither is an operational feature. Raw candidate logs:
`/private/tmp/cyberdeck-resource-candidate-15e455d`. Keep raw/private materials local.
