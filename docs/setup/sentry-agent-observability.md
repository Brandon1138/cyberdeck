# Local activity and optional Sentry export

Current dependencies: Sentry Node/OpenTelemetry 10.73.0, OTel API 1.9.0, OTel SDK/core 2.11.0. Exactly one NodeTracerProvider is registered with SentrySampler, SentrySpanProcessor, SentryPropagator and SentryContextManager; automatic integrations and ESM instrumentation hooks are disabled.

Local instruction activity is recorded after acknowledged instruction persistence. Every container-native semantic turn (Claude/Codex) is bound to exact receipts and durable byte cursors under the identity that dispatched it, recorded in `origin`: `instruction` (a consumed queued instruction), `initial-prompt` (the launch prompt event), `direct-input` (a human composer prompt event) or `unattributed` (nothing the broker recorded, for example pane typing or a provider-internal turn). Tool invocations and results link to the turn's start marker; the turn's completion carries the observed interval. Turns still running are read at quiet points under the same identity. Host-native tools and Cursor/Antigravity native capture remain unavailable and are recorded as gaps. Coordination reports, controls and handoffs project after the
existing atomic commit and deduplicate on replay; missing session mappings durably degrade capture. The source fixtures are not live provider proof. Activity inspection reports provenance and retention loss:

```sh
rtk cyberdeck activity --run <instruction-or-run-uuid> --after 0 --limit 100
rtk cyberdeck activity --run <uuid> --export /absolute/new-local-page.json
rtk cyberdeck activity --session <worker-session-uuid> --after 0 --limit 100
```

Sentry is disabled unless broker config explicitly sets `sentry.enabled: true`, a selected `dsn`, and an actual-quota-derived `dailyEnvelopeCap`. `sampleRate` defaults to 0.1. Do not activate this configuration until the operator authorizes telemetry and supplies project/region/allowance; these values remain missing. No account settings or active configuration were changed.

SDK envelopes are rebuilt at the transport boundary from a strict metadata schema. Prompts, transcript/source/diff/tool bodies, arbitrary names/tags, exception text, paths, headers and breadcrumbs are excluded. Unsupported model metadata is omitted. Events with native start/end evidence export observed turn/tool intervals (`cyberdeck.timing=provider-native-interval`); other events remain observation markers. Neither represents provider HTTP timing. Raw native arguments/results remain local references. Causal investigations use run/worker/session/instruction/event IDs to locate local records. Remote trace evidence and complete causal span instrumentation are outstanding gates.

Export queue: at most 100 envelopes, 2-second request timeout, 60-second failure/429 backoff, automatic retry/draining without new activity, bounded flush. Daily head-sampling/cap state persists before enqueue; retry/queue-cap/hung-transport/shutdown tests pass; remote quota reconciliation remains unverified. Export failures do not throw into instruction persistence. A DSN is parsed into the Sentry envelope endpoint, never used as an OTLP URL. Workers receive no Sentry configuration.

Local storage uses a disposable SQLite location index over canonical fsynced JSONL. The index is unlinked and rebuilt at every open, so a corrupt index never blocks the recorder; its bytes count against the 2 GiB cap together with the journal, pruning frees a batch and vacuums once per batch, and a failed write is recovered by re-reading the journal on the next append with the loss counted. `activity.health` reports `journalBytes`, `indexBytes`, `capBytes`, `pinned` and `uncertain`. `rtk cyberdeck activity-pin --run UUID` persists an incident pin; add `--release` to unpin. Pins block prefix eviction, so a full cap with a pin refuses new writes visibly (`ACTIVITY_PINNED_CAPACITY`). Replay after retention cannot deduplicate against evicted rows.

Required canary: one explicitly authorized named run at 100% sampling, remote trace link matched to local IDs, actual account allowance recorded, envelope privacy reviewed, and offline/failed-sink broker outcomes compared. No remote canary or model run has occurred.
