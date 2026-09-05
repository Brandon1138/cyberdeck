# Scratch container boundary proof — 2026-09-05

This is no-model runtime-adapter proof. It does not close provider login, real broker crash/handoff, or live behaviour gates.

Image: `sha256:89d5c37a193e8103998593ad0b7a7fdbfc89720b1c0eefbdea8f7820c3297f71`.
Base: `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
Guest versions actually observed: Claude 2.1.261, Codex 0.153.4. No model call or account credential was used.

Passing evidence directory:
`/var/folders/dn/ts3sd7810lb9wv8j58h_3qrh0000gn/T/cyberdeck-container-proof-eJOOwF`

`output.txt`: UID 1000, memory.max 268435456, cpu.max 100000 100000, denied workspace write, forbidden paths absent, authenticated report acknowledged, interactive echo and guest resize 93x31.
`running-inspection.json`: actual image, ownership labels, mounts and security/resource settings.
`collected/`: hashed workspace/provider-state facts and guest logs, after confirmed stop.
`result.json`: success true, slot released, cleanup absent. Private clone and local evidence retained.

Earlier attempt `miAhWn` confirmed most boundaries but failed resize through a nonexistent Docker CLI command and blocked collection on Codex's absolute helper symlinks. Its stopped container was retained. The fix uses the Engine resize API and hashes provider-state symlink text without following it. Recovery collection is recorded separately; this failed attempt is not relabelled a pass.

The API key credential adapter, source-hash selection, runtime backend and scoped gateway are not yet composed into ordinary broker launches. Defaults remain host; explicit container requests on the broker fail closed until that composition and proof land. Provider/native-host exceptions remain unaccepted, not silently supported.

Recovery after the collector fix: `miAhWn/recovery.json` records stopped execution `9f3d2f78-d275-4cc8-8b42-60e126caf7a3`, a completed collection manifest, and final `absent`. All scratch containers created by these runs are removed; image and private clones/evidence remain.
