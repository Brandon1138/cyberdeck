# Changelog

All notable changes to Cyberdeck are documented here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) while its public API
and persisted schemas remain under active alpha development.

## [Unreleased]

## [0.1.0-alpha.1] - 2026-07-23

### Added

- Provider-neutral local broker for durable Codex, Claude, Cursor, and
  Antigravity terminal sessions.
- Interactive Fleet and optional tmux cockpit views without transferring
  process ownership away from the broker.
- Explicit provider, model, effort, sandbox, orchestration, worker, workflow,
  budget, and concurrency controls.
- Durable session metadata, transcripts, preferences, job records, artifacts,
  recovery, and provider-native resume where supported.
- Session-scoped MCP tools for bounded worker orchestration and report-back.

### Security and privacy

- Real provider and model calls are never part of the deterministic test suite.
- Fable worker launches remain default-off and require an explicit operator
  grant.
- Transcript and state persistence is local to the current macOS user.

### Known limitations

- This developer preview supports macOS only.
- Users must install and authenticate each provider CLI independently.
- Cursor and Antigravity session resume remain unsupported; some launch paths
  are fixture-proven but not yet live-verified across all provider versions.
- Provider CLI behavior and supported model identifiers can change independently
  of Cyberdeck.

[Unreleased]: https://github.com/Brandon1138/cyberdeck/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/Brandon1138/cyberdeck/releases/tag/v0.1.0-alpha.1
