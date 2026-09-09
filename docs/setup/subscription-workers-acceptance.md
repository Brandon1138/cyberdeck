# Subscription worker verification — 2026-09-09

Implemented from main `9a11fc59875d26d24fcb17611de033fbf33588fd`. All requested acceptance
gates passed; this report accompanies the completed local commit. Worker image used:
`sha256:5043f92749d450ccca5a28c1048f9a5e94bdc861da2e93e40978e9636887e5da`
(Claude 2.1.261, Codex 0.153.4).

| Evidence | Result |
| --- | --- |
| Claude Max subscription, Haiku | Passed through the new writable network boundary; native successful command and attributed turn; session `18e82e31-191e-4407-9663-efef8aa9e386` |
| Codex ChatGPT subscription, gpt-5.6-luna, read-only | Successful command and explicit `exit_code=0`; native tool/result and attributed completion; session `4fb6a7e3-204a-41d8-85e6-bf356dd6eb1e` |
| Codex workspace-write | PASSED with explicit `danger-full-access` / `never`: real file edit, offline npm dependency installation, command/exit-status verification and accepted reporting; session `0abf5644-f8ee-4dec-89d9-ca2d2b595c04`, execution `12491dbd-6a04-47f4-83f6-d441839bd89b` |
| Network containment | PASSED: two hardened writable guests denied host alias/IP/gateway, localhost, cross-worker, private/metadata, direct Internet and IPv6 probes; report readiness and own-worker reports accepted, cross-worker report forgery denied, all four approved HTTPS hosts returned verified TLS responses. Host sentinel received zero requests; both guests were removed |
| Resume | PASSED: actual Codex generation 2 retained execution identity and `danger-full-access` / `never`, renewed the activation nonce and reinstalled the firewall; host sentinel remained unreachable |
| Credential boundary | Guest Codex auth is `chatgptAuthTokens`, no API key, empty refresh token, mode 0600; Claude gets only its selected subscription access token |
| Tests | Latest full run: 188 files / 2,211 tests passed with four workers; production build/typecheck and diff whitespace check passed. An earlier unbounded-concurrency run hit an existing shell-stream timing assertion; isolated recheck and the full bounded run passed |
| Sentry | Existing sink active; successful writable canary queue drained with zero sink drops. All 32 final Codex envelopes passed the real SDK/serializer privacy audit, including injected ambient PII exclusion. Remote indexing and attribution PASSED for the exact successful Codex span and lifecycle IDs. Remote privacy PASSED after explicit unspecified-IP serialization and approved project scrubbing; final probe details below |

Evidence directories under `/var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/`:

- `cyberdeck-claude-subscription-canary-aiLnyr/canary.json`: earlier passing Claude canary before network hardening.
- `cyberdeck-codex-subscription-canary-jVNUrE/verification.json`: native-result verification of
  the passing read-only Codex command. Its original `canary.json` remains unchanged with a false
  harness result: the initial checker did not recognize Codex's split custom-tool output blocks.
  The corrected checker requires the actual command output and explicit zero exit status.

Earlier failed canaries are retained as failures, including Codex's false “OK” after a sandbox
error. They are not counted as successful command execution.

Live verification also exposed two Claude capture issues fixed here: separate thinking/text
blocks carrying the same `end_turn`, and completion reconciliation gated on recognizable terminal
spinner text. Container reconciliation now accepts only the exact bound native transcript without
requiring a spinner match. Host behavior is unchanged; both changes have regression tests.

During broker restart, a stale competing startup and a duplicate activity replay prevented local
capture. The stale process was stopped. A private original journal and SHA-256 recovery record
were saved at `~/Library/Application Support/Cyberdeck/activity/recovery-20260909T095344Z/` before
removing only duplicate sequence 994 (identical except sequence/observation time). Recorder health
returned to non-degraded with no uncertain state. No distinct activity was removed.

Normal routing remains host by default; subscription containers are explicitly selected. Sentry
uses a 5,000-envelope daily cap and normal 10% sampling (100% during canaries). The DSN and login
sources are configured outside git. Report-back and generation-2 startup are now verified above.
Running-token expiry remains a separate proof boundary. Remote indexing and server-side IP privacy are verified below.

The main broker health check confirmed config mode `0600`, native Codex isolation, Sentry
sampling `0.1`, daily budget 1,131/5,000, queue 0, sink drops 0, and non-degraded local activity.
The two budget drops are separate from sink delivery failures. No main broker restart or opt-in
activation was performed. All requested canary, containment, attribution and privacy gates have passed.


## Network-boundary acceptance evidence

The initial bridge-only host access failure was reproduced and fixed before enabling the canary
opt-in. Final hardened suite: `cyberdeck-network-proof-QZdAWh/result.json` under the temporary
root above. Earlier failed fixture runs remain failures; they are not counted as passing proof.
The first needed a pinned gateway alias because general DNS was correctly blocked; the second
used an obsolete Docker inspection field. Final HTTPS checks distinguish a verified TLS response
from a proxy-side 403 refusal.

New canaries ran on an isolated instance of the **production broker composition**, socket
`/tmp/cyberdeck-network-canary-501.sock`, state directory
`/private/var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/cyberdeck-writable-acceptance-1P9Uua`.
This preserved two active host orchestrators. Its private config used the explicit writable opt-in
and a separate durable 100-envelope budget at 100% sampling; the main broker's config and budget
were not reset or changed. The main runtime has not been restarted onto these changes.

- `cyberdeck-codex-subscription-canary-FWLDiR/canary.json`: passing writable Codex canary.
- `cyberdeck-claude-subscription-canary-pX9Z6o/canary.json`: passing Claude canary through the firewall/proxy.
- `cyberdeck-writable-acceptance-1P9Uua/privacy.json`: all 32 actual Codex event envelopes passed privacy assertions.
- `cyberdeck-writable-acceptance-1P9Uua/resume-containment.json`: generation-2 actual Codex resume proof.

The first writable attempt (`cyberdeck-codex-subscription-canary-cKF7wq`) created the expected
artifacts but omitted explicit exit status in its tool-wrapper output. It remains failed harness
evidence. It also exposed host CLI reporting instructions in a guest without that CLI. Container
instructions now direct workers to the existing MCP/report helper; the passing canary submitted
two accepted reports. No second reporting or Sentry integration was introduced.

## Remote indexing and final cleanup

The signed-in Sentry span table, filtered by session
`0abf5644-f8ee-4dec-89d9-ca2d2b595c04`, showed the exact locally derived lifecycle
span IDs: preparing `65acf7a04897071f`, ready `4958620902aeee16`, running
`b6770b39e5db7f4a`, stopped `f0bf80b77d8d6c7d`.

The [successful agent trace](https://mikoshi-ej.sentry.io/explore/traces/trace/dc6984fb840c817c4e62ae026a0f5948/)
contains span `abe2e61f040b52a5`, duration 52.58 seconds. Expanded remote attributes
confirmed provider `codex`, execution `12491dbd-6a04-47f4-83f6-d441839bd89b`,
generation 1, worker matching the canary session, outcome `succeeded`, provenance
`provider-native`, and coverage `complete-for-source`. This is remote indexing proof.

Both canary sessions were retired and their containers/credential mounts removed. Final
isolated health: sessions 0, queue 0, sink drops 0, budget 78/100 with zero budget drops.
The isolated broker was shut down; no network helper containers remained. Evidence is
`cyberdeck-writable-acceptance-1P9Uua/final-health.json`. The main broker was left running.

## Final remote privacy verification

The operator approved IP storage prevention and a narrow geolocation scrub. Computer Use
confirmed the Cyberdeck project saved both “Prevent Storing of IP Addresses” and
`[Remove] [Anything] from [user.geo.**]`. Fresh probes proved these server settings alone
still allowed connection-derived location enrichment. Failed probes remain recorded, not
counted as successful privacy evidence.

The existing closed serializer now emits only the constant unspecified IP `0.0.0.0` in
its user field. It never copies ambient user data. This prevents Sentry inferring the real
transport IP for geolocation; project scrubbing removes the constant address. The existing
regression now injects ambient IP, email and geo data and verifies they cannot cross the
serialization boundary. No second telemetry integration was added.

A fresh metadata-only evaluation probe through the existing sink was remotely indexed:
[trace d8c85492a4731f2f4a88fabb6f51d801](https://mikoshi-ej.sentry.io/explore/traces/trace/d8c85492a4731f2f4a88fabb6f51d801/),
span `6c1585ea793e5b7f`, event `a873f515-f8cf-487f-b7bb-393969b87c55`. Expanded
Sentry attributes showed the exact session/worker IDs and successful outcome, no `user.geo`
attributes, and only the scrubbed `ip:[ip]` marker. Queue 0, delivery drops 0; bounded
follow-up budget 4/5. Evidence: `unspecified-ip-followup.json` in the acceptance state
directory. This privacy probe is separate from the previously proved live provider canaries.

All 32 actual Codex envelopes were rechecked with the updated SDK/serializer and passed
(`/tmp/cyberdeck-final-privacy.json`). The focused observability suite passed 10 tests;
production build and whitespace checks passed. Earlier full suite: 2,211 tests.
Historical events already indexed before the privacy fix were not deleted or rewritten.
The main broker still needs a reload onto this code when its active host orchestrators
can be preserved; the isolated acceptance broker and all test guests are shut down.
