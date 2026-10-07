# Future Mac mini installation

Status: preparation only. No mini has been purchased or tested. This runbook does not certify
MacBook operation or mini readiness; the unresolved gates in
[resource-managed-operation.md](resource-managed-operation.md) apply first. Keep the Cyberdeck
budget at 8,589,934,592 bytes. A MacBook with a configured 8 GiB policy does not reproduce the
memory pressure of a base mini with 16 GiB total RAM.

## Record the target before installing

Record the exact machine model, RAM, macOS build, free disk, Xcode build and selected developer
directory. Use the same reviewed source commit, lockfiles and worker/evaluator image digests as
the accepted MacBook candidate. Rebuild native helpers for the target architecture and record
their hashes; never copy PID/birth identities from the laptop.

Install Node 24.18.0 and pnpm 11.5.0 through the operator's chosen version manager. Install
OrbStack, Xcode and simulator runtimes through their supported installation flows. Accepting
licenses, logging in, changing Remote Login/FileVault or account settings is an operator step.
Do not disable security settings to make startup appear unattended. Record these read-only
checks on the target:

```sh
rtk proxy sw_vers
rtk proxy sysctl -n hw.model hw.memsize
rtk proxy node --version
rtk proxy pnpm --version
rtk proxy xcode-select -p
rtk proxy xcodebuild -version
rtk proxy codex --version
rtk proxy claude --version
rtk proxy tmux -V
```

Record actual provider model/effort discovery separately from CLI versions. Use first-party
Codex Orc routing and existing subscription login. No API key, credit billing or provider
substitution is part of this installation. Guest credentials remain bounded access snapshots;
operational admitted refresh must be verified before unattended work can be promised.

## Private installation and startup

Choose an absolute private state directory owned by the login user (directory mode 0700,
secret-bearing files 0600). Preserve the original config and consistent quiescent journal
snapshot before a migration. Stage the concrete configuration with
`scripts/prepare-resource-config.ts`; verify the source, image, profile and proposed config
hashes before applying it. Never commit these private configurations or print credentials.

Configure one installation UUID and one resource owner directory. Its broker is the sole
budget writer; a second broker must not claim a second independent 8 GiB pool. Explicitly
account for Fleet, provider/MCP processes, evaluator and owned services. Reinspect the
OrbStack endpoint and VM birth identity on the target. An Engine/VM restart invalidates the
old identity and must hold admission until recovery establishes the replacement. Do not
change shared VM limits or restart foreign services as an implicit part of bootstrap.

Use the target's supported user-session supervision for the one broker. A LaunchAgent runs
only after that user logs in; it does not bypass FileVault unlock, Keychain access, subscription
login or OrbStack's user-session startup. Before installing any service definition, stage its
exact executable/arguments, private working directory, bounded logs and single-instance
ownership for review. Do not enable a restart loop until crash recovery and held-reservation
reconciliation pass. This candidate does not yet provide a verified service definition.

Start with an isolated **headless** broker and unique state/socket/identity. The installed-package
smoke must use explicit `runBroker(socket, state)` arguments; the current CLI broker commands
address their default installation. Do not use those commands as fixture isolation. A second
Fleet/nvim UI requires the alternate-checkout version/namespace ownership gates first.

## Remote operation and physical acceptance

Run the existing terminal interface on the mini through SSH/tmux. Keep the local broker on its
private Unix socket; do not expose its unauthenticated protocol over TCP or forward a Docker
socket to a worker. Test disconnect/reconnect with a bounded task: canonical queue, attempts,
evaluation and process ownership must remain on the mini after the laptop disconnects.

Repeat W0–W10, the three measured eight-worker W1 runs after warm-up, the 100-cycle plateau,
24-hour soak and the full fault matrix on the physical mini. Include the unsigned simulator
fixture and a representative native project, scoped Docker service cleanup, subscription
expiry/refresh and a fresh matched workload Sentry receipt. Test real cold boot/login recovery,
sleep/wake and safe host-pressure response without deliberately exhausting the machine.
Record each operator login/unlock intervention rather than calling it unattended recovery.

Only after those results pass can the physical-mini gate change to verified. Activation still
uses the concrete reviewed config/image package, safe drain window, default-routing canaries
and compatible rollback snapshot described in the operation runbook. Preserve failed and
unverified evidence; missing hardware or authentication is not a passing result.
