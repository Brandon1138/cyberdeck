# Worktree provisioning

Isolation is a spawn-time choice Cyberdeck owns, not a shell step an orchestrator has to remember.
A worker either runs in a checkout that already exists, or Cyberdeck cuts a fresh worktree for it
before the provider process is started. Both are declared the same way, on the `workspace` block a
worker already carries.

## The three provisioning modes

`workspace.provisioning` names who is responsible for the worktree the worker runs in:

| Mode | Who creates the worktree | `worktreePath` | What it is for |
| --- | --- | --- | --- |
| `pre-provisioned` | The caller, before spawning | required, must exist | "Main/branch": run in a checkout or branch you already have |
| `cyberdeck-provisioned` | Cyberdeck, at spawn | optional; derived when absent | "Own worktree": a fresh, isolated worktree per worker |
| `worker-provisioned` | The worker itself, at runtime | required | The worker runs `git worktree add`, and needs the git common directory writable to do it |

`pre-provisioned` is how a worker runs directly in the operator's checkout, and it stays explicit:
nothing silently upgrades or downgrades a start between modes. A `cyberdeck-provisioned` start when
no provisioner is configured is **refused** (`WORKSPACE_PROVISIONER_UNAVAILABLE`) rather than
quietly run in the operator's checkout — the failure mode the mode exists to prevent.

`worker-provisioned` is the mode that produced the 2026-08-14 failure (`cannot lock ref …
'Operation not permitted'`): a worker holding only its own worktree writable cannot write the
shared `.git` it needs to create a branch. `cyberdeck-provisioned` makes that unreachable by doing
the creation outside the sandbox, before the provider exists.

## Where provisioning happens

In `SessionRegistry.start`, after admission and reservation and before any provider process. Both
the MCP `workers_start` path and Fleet's direct start go through it, so there is exactly one
implementation and no second mechanism to keep in sync. Validation and path derivation live in
`src/domain/worker-workspace.ts` and are reused by `AgentControlService`, so a start is refused for
the same reasons wherever it came from.

Creating the worktree emits a `workspace.provisioned` broker event, and the session's `cwd` becomes
the new worktree. `workspace.repositoryPath` records the repository it was cut from, which is what
Fleet groups the thread under — so a sibling worktree appears under its project with the worktree
name in the worktree column, not as a stray top-level folder.

If anything fails after provisioning, the registry discards the worktree it just made. That is the
only automatic removal in the system, and it is not forced: `git worktree remove` and
`git branch -d`, both allowed to fail.

"Anything" includes the `workspace.provisioned` journal append itself, which is why that append
discards and rethrows rather than propagating: it runs before the `ProvisionedWorktree` reaches the
caller, so the caller's own discard path cannot see a worktree the append failed behind. Left
behind, the branch and the deterministic path would refuse the operator's immediate retry with
`WORKSPACE_BRANCH_EXISTS` / `WORKSPACE_TARGET_EXISTS`.

## Naming policy

```
<repository-parent>/<repository-name>-<branch-leaf-slug>
```

For a branch `cyberdeck/mik-75-worktree-provision` in `/Users/me/code/cyberdeck`, that is
`/Users/me/code/cyberdeck-mik-75-worktree-provision`.

Three choices, each load-bearing:

- **Sibling, not nested.** A worktree inside the repository shows up as an untracked directory in
  `git status` and in every glob the worker runs. A sibling is invisible to the repository it came
  from.
- **Named after the branch, not the session.** A UUID-named directory is unreadable in `tmux`, in
  the Fleet worktree column, and in `ls`. The branch leaf is what the operator already thinks in.
- **Deterministic, with no uniquifying suffix.** There is no `-2`. If the target path already
  exists, the start is refused (`WORKSPACE_TARGET_EXISTS`), as it is when the branch already exists
  (`WORKSPACE_BRANCH_EXISTS`). Two workers meant to be on one branch is a mistake worth hearing
  about, and a silent `-2` would hide it until review time.

## Provenance

Each provisioned worktree gets a `cyberdeck-provenance.json` recording the session, branch, base
ref, base commit, repository, and creation time. It is written into that worktree's own git admin
directory (`git rev-parse --absolute-git-dir`), **not** into the working tree — a marker file in the
working tree would appear in the worker's diff and in every PR it opens.

Provenance is the only thing that makes a worktree eligible for reclamation. A worktree without it
is not Cyberdeck's and is never touched, whatever it looks like. A provenance file with no
`baseCommit` is in the same position: there is no baseline in it, and guessing one is exactly the
failure `baseCommit` exists to prevent.

**The baseline is a commit, not a name.** `baseRef` is kept as the operator declared it, and the
worktree is cut from `baseCommit` — `git rev-parse --verify <baseRef>^{commit}` in the source
repository, at provisioning time. Retention diffs against `baseCommit` and only `baseCommit`. A
symbolic base does not survive the worktree: Fleet's `/worktree on` declares `HEAD`, which read back
inside the worktree names the worktree's own tip, so `HEAD..HEAD` is empty however many commits the
worker made — a worktree full of unpublished work would report `commitsAheadOfBase: 0` and be
removed by `worktree prune --yes` under a rule written to keep it.

The recorded base is read by retention and by nothing else. In particular
`src/nvim/worktree-changes.ts` still resolves its diff baseline from `refs/remotes/origin/HEAD`, and
the deferred limitation in `CLAUDE.md` about a worktree with no `origin/HEAD` is unchanged: this
feature records a base for the worktrees *it* creates, and deliberately does not widen the change
list's baseline guessing to use it.

## Retention and cleanup policy

**Creation is automatic. Removal never is.** This is the same stance as
[app-server-and-worktree-leases.md](app-server-and-worktree-leases.md), where lease recovery
reports orphans and refuses to clean them up: the broker deletes no Git state on a timer, on
startup, or on a worker's death.

Reclamation happens only when the operator runs `cyberdeck worktree prune --yes`. Without `--yes`
the command prints the plan and changes nothing.

`retentionVerdict` in `src/orchestration/worktree-inventory.ts` is the whole policy, in order:

1. **A live worker's worktree is kept.** Something has those files open. "Live" means *no process
   exit has been recorded* — `exitCode === null` — rather than a whitelist of execution states. An
   `errored` session keeps `exitCode: null` deliberately, because its process is still there and
   deleting the thread still requires stopping it; a `cancelled` session has been sent `SIGTERM` but
   has the same gap until its exit callback lands. Both sit in a clean worktree, and both would be
   read as unused by any rule that asked whether the session was `starting` or `active`.
2. **A dirty worktree is kept.** Uncommitted work exists nowhere else.
3. **A worktree with commits that are not in its base ref and not on any remote is kept.** That is
   unlanded work; removing the worktree would remove the only copy.
4. **Anything else is removable.** Its contents are reproducible from refs that outlive the
   directory.

When a worktree is removed, its **branch** is deleted only if the base ref already contains
everything on it. A branch that is pushed but not merged keeps its name — the directory is
reproducible, the name is how the operator finds the work again.

Removal uses `git worktree remove` and `git branch -d`. Neither is ever forced, so Git gets the
last word: if anything changed between the verdict and the removal, it fails instead of
overriding.

There is no age threshold and no timer. There is no number of days after which unlanded work
becomes safe to delete, and a worktree that is safe today is equally safe next week — a clock would
only choose *when* to surprise the operator.

A base ref that no longer resolves does not read as "nothing to preserve": the count is treated as
unbounded and the worktree is kept.

## Node repositories and `node_modules`

**Cyberdeck runs no package manager in a provisioned worktree, and creates no `node_modules`
symlink.** A fresh worktree of a Node repository has no `node_modules`, and the worker is expected
to say so rather than be handed a broken one.

The hazard being avoided is specific and has bitten this repository: when `node_modules` in a
worktree is a symlink to another checkout's install, `pnpm install` run from the worktree tries to
*delete* the shared directory it points at, taking the main checkout's install with it. Provisioning
a symlink would hand every worker that landmine and make it look like a supported setup.

Running the install instead was rejected too: it needs network access and minutes of wall clock
before the worker's first turn, and it picks a package manager Cyberdeck has no business choosing.

So the stance is to do neither and to be loud about it. When the source repository has a
`node_modules` and the new worktree does not, provisioning returns a warning that says so, says
Cyberdeck provisions git state only, and says to install *inside* the worktree rather than link the
repository's `node_modules` into it. The warning rides on the `workspace.provisioned` broker event.
If an orchestrator wants a pre-installed tree, that is what `pre-provisioned` is for.

## Commands

```
cyberdeck worktree list [path] [--json]   # provisioned worktrees and their verdicts
cyberdeck worktree prune [path]           # print the plan
cyberdeck worktree prune [path] --yes     # reclaim what the policy clears
```

Both take a path inside the repository and default to the current directory. Both consult the
broker for live sessions; if no broker is running they still work, and every other rule still
applies.
