# Local activity and optional Sentry export

Current dependencies: Sentry Node/OpenTelemetry 10.73.0, OTel API 1.9.0, OTel SDK/core 2.11.0. Exactly one NodeTracerProvider is registered with SentrySampler, SentrySpanProcessor, SentryPropagator and SentryContextManager; automatic integrations and ESM instrumentation hooks are disabled.

Local instruction activity is recorded after acknowledged instruction persistence. Native Claude/Codex parser/collector interfaces exist, but production transcript cursor/turn binding and all control/handoff emitters remain incomplete. Cursor/Antigravity native tool capture is unavailable. The source fixtures are not live provider proof. Activity inspection reports provenance and retention loss:

```sh
rtk cyberdeck activity --run <instruction-or-run-uuid> --after 0 --limit 100
rtk cyberdeck activity --run <uuid> --export /absolute/new-local-page.json
```

Sentry is disabled unless broker config explicitly sets `sentry.enabled: true`, a selected `dsn`, and an actual-quota-derived `dailyEnvelopeCap`. `sampleRate` defaults to 0.1. Do not activate this configuration until the operator authorizes telemetry and supplies project/region/allowance; these values remain missing. No account settings or active configuration were changed.

SDK envelopes are rebuilt at the transport boundary from a strict metadata schema. Prompts, transcript/source/diff/tool bodies, arbitrary names/tags, exception text, paths, headers and breadcrumbs are excluded. Unsupported model metadata is omitted. Exported activity currently consists of instantaneous observation markers (`cyberdeck.timing=observation-marker`), not provider HTTP timing or full agent-turn/tool-duration spans. Causal investigations use run/worker/session/instruction/event IDs to locate local records. Remote trace evidence and complete causal span instrumentation are outstanding gates.

Export queue: at most 100 envelopes, 2-second request timeout, 60-second failure/429 backoff, bounded flush. Daily head-sampling/cap state persists before enqueue; retries and remote quota reconciliation still need acceptance stress tests. Export failures do not throw into instruction persistence. A DSN is parsed into the Sentry envelope endpoint, never used as an OTLP URL. Workers receive no Sentry configuration.

Required canary: one explicitly authorized named run at 100% sampling, remote trace link matched to local IDs, actual account allowance recorded, envelope privacy reviewed, and offline/failed-sink broker outcomes compared. No remote canary or model run has occurred.
