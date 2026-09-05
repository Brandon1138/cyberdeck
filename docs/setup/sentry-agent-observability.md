# Local activity and optional Sentry export

Current dependencies: Sentry Node/OpenTelemetry 10.73.0, OTel API 1.9.0, OTel SDK/core 2.11.0. Exactly one NodeTracerProvider is registered with SentrySampler, SentrySpanProcessor, SentryPropagator and SentryContextManager; automatic integrations and ESM instrumentation hooks are disabled.

Local instruction activity is recorded after acknowledged instruction persistence. Completed queued instructions bind Claude/Codex container native turns to exact semantic receipts and durable byte cursors, with parent links from accepted instruction through turn, invocation and result. Initial prompts, direct input, in-progress turns, host-native tools and control/handoff emitters remain incomplete. Cursor/Antigravity native tool capture is unavailable. The source fixtures are not live provider proof. Activity inspection reports provenance and retention loss:

```sh
rtk cyberdeck activity --run <instruction-or-run-uuid> --after 0 --limit 100
rtk cyberdeck activity --run <uuid> --export /absolute/new-local-page.json
```

Sentry is disabled unless broker config explicitly sets `sentry.enabled: true`, a selected `dsn`, and an actual-quota-derived `dailyEnvelopeCap`. `sampleRate` defaults to 0.1. Do not activate this configuration until the operator authorizes telemetry and supplies project/region/allowance; these values remain missing. No account settings or active configuration were changed.

SDK envelopes are rebuilt at the transport boundary from a strict metadata schema. Prompts, transcript/source/diff/tool bodies, arbitrary names/tags, exception text, paths, headers and breadcrumbs are excluded. Unsupported model metadata is omitted. Events with native start/end evidence export observed turn/tool intervals (`cyberdeck.timing=provider-native-interval`); other events remain observation markers. Neither represents provider HTTP timing. Raw native arguments/results remain local references. Causal investigations use run/worker/session/instruction/event IDs to locate local records. Remote trace evidence and complete causal span instrumentation are outstanding gates.

Export queue: at most 100 envelopes, 2-second request timeout, 60-second failure/429 backoff, automatic retry/draining without new activity, bounded flush. Daily head-sampling/cap state persists before enqueue; retry/queue-cap/hung-transport/shutdown tests pass; remote quota reconciliation remains unverified. Export failures do not throw into instruction persistence. A DSN is parsed into the Sentry envelope endpoint, never used as an OTLP URL. Workers receive no Sentry configuration.

Local storage uses a disposable SQLite location index over canonical fsynced JSONL. `rtk cyberdeck activity-pin --run UUID` persists an incident pin; add `--release` to unpin. Pins conservatively block prefix eviction; index overhead/corruption recovery remain review gates.

Required canary: one explicitly authorized named run at 100% sampling, remote trace link matched to local IDs, actual account allowance recorded, envelope privacy reviewed, and offline/failed-sink broker outcomes compared. No remote canary or model run has occurred.
