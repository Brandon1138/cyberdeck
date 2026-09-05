# Worker infrastructure preflight — 2026-09-05

Accepted implementation baseline: `70190e2b3c7834011f39c0418764c2e4aca19b37`.
Branch: `feat/worker-infrastructure-execution`.
Workspace: `/Users/brandon/code/personal/cyberdeck/worktrees/worker-infrastructure`.

The primary checkout remains on main. Its untracked AGENTS.md, handoffs/ and three planning files are preserved. Only the requested design and implementation plan were copied into this worktree. No Fleet/nvim surface or second active broker was started. The linked August 29 Linear design was read in full; September's accepted corrections supersede its shared-worktree and lease-lifetime assumptions.

## Accepted configuration

- Durable worker-owned environment; independent clone/private Git, provider state, credentials, caches and transcripts. No controller identity derivation added.
- Explicit `orbstack-container`; host remains the canary-stage compatibility default. Container requests never fall back. Native host exceptions require a named profile/reason at rollout.
- Requested sandbox/approval/transport remain independent. Read-only mount for read-only requests; no automatic permission reinterpretation.
- Proposed capacity: 4 slots, 2 CPU / 4 GiB each, subject to live VM capacity. Attempt timeout 60 minutes; failed stopped compute retained 24 hours. Collection must succeed before destructive retirement.
- Local diagnostics: 30 days / 2 GiB; visible gaps, pinning/export. Sentry disabled until authorized, normal trace sample 10%, bounded named canary 100%. Actual project allowance and measured volume determine export caps.
- Egress or none; no domain allowlist claim. No Docker/broker socket, home, Keychain, SSH agent or shared Git mounts.

## Refreshed host facts

| Component | Observation | Proof boundary |
|---|---|---|
| HEAD | 70190e2 | Live Git inspection |
| Node on PATH | 26.7.0 | Unsupported by package; task-local 24.18.0 downloaded for checks |
| pnpm | 11.5.0 | Host version |
| Docker client | 29.4.0 darwin/arm64 | Host version |
| OrbStack | 2.2.3 (2020300), c83556b | Initially stopped; explicit start succeeded under host permissions |
| Docker endpoint | unix:///Users/brandon/.orbstack/run/docker.sock | Initially absent; exists after start, restricted sandbox cannot connect |
| Claude | 2.1.261 | Host version only |
| Codex | 0.153.4 | Host version only |
| Cursor | 2026.08.11-e8db854 | Host version only |
| Antigravity | 1.1.27 | Host version only |

Provider Linux authentication, image digests, PTY/report-back, limits and recovery remain unproved. No model requests or credentials were inspected. Sentry project/region/DSN/quota and activation authorization are missing; live evaluation provider/model and total spend ceiling are missing. These block only dependent remote/live gates.

Required integration checks: pnpm check, test, build, architecture/file-size ratchets, packed CLI install and git diff --check. Use Node 24.18.0. No baseline ceilings may be raised.

Live host-permitted Docker info: Engine 29.4.0 / OrbStack aarch64, 12 CPUs, 12,599,844,864 bytes RAM, memory limits supported. Twelve pre-existing containers were present; none were modified or removed. Capacity preflight cannot admit four 4-GiB reservations: cap the initial ordinary profile at two slots (8 GiB aggregate), leaving about 3.7 GiB VM headroom. Global context was already orbstack and was not switched.
