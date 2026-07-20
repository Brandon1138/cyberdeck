# Cyberdeck Setup and Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline, task by task, with review checkpoints. Do not use subagent-driven development and do not spawn subagents.

**Goal:** Build the first testable Cyberdeck vertical slice: a neutral local broker that owns durable Claude and Codex terminal sessions, lets either session move between attached/interactive and detached/headless operation, and permits one bounded delegated worker without encoding premature model roles or workflows.

**Architecture:** A TypeScript daemon owns provider processes through pseudo-terminals and exposes a JSONL protocol over a short Unix socket. Thin CLI clients start, list, send to, attach to, watch, detach from, and stop sessions; tmux only displays clients, so closing a pane does not own or kill the underlying agent. Provider, model, role, permissions, and attachment state remain independent data, and Phase 1 performs no automatic provider or model routing.

**Tech Stack:** Node.js 24.18.0 via mise, TypeScript, pnpm 11.5.0, Vitest, `node-pty`, Zod, Commander, Unix-domain sockets, tmux 3.6a.

---

## Scope and policy locks

This plan implements only Setup and Phase 1. It must not implement provider ranking, automatic fallback, reusable workflows, model-to-role mappings, worktree orchestration, semantic memory, Cursor, Antigravity, or Fable advisory automation.

The following rules are contractual:

- Code lives at `/Users/brandon/code/personal/cyberdeck`.
- Work is executed inline. No subagents are used during implementation or review.
- Claude and Codex are equal session runtimes. Either may be attached or detached.
- A session is durable for the life of the broker and can be reattached. A one-shot job is a different primitive and is not implemented in Phase 1.
- Provider, model, role, sandbox, and attachment mode are independent fields.
- `role` is an optional opaque string. Cyberdeck does not define `explorer`, `scout`, `implementer`, `advisor`, or other role semantics.
- There is no automatic model selection and no default workflow.
- Fable is the premium model requiring explicit human permission. Phase 1 enforces this conservatively by rejecting Fable from every delegated session. A human may start a top-level Fable session explicitly with `cyberdeck start --provider claude --model fable`.
- Opus is not premium-gated and is not restricted to advice. It may be started or delegated like any other ordinary model.
- The broker never starts Fable automatically, never maps an `advisor` label to Fable, and never substitutes Fable as a fallback.
- Closing an attach client or tmux pane detaches the view without terminating the provider process.
- One controlling client may send keystrokes to a session. Additional clients are read-only watchers.
- Delegation depth is limited to one and requires an explicit provider. Phase 1 does not infer a provider from the role.
- Runtime updates are disabled in spawned Claude processes with `DISABLE_UPDATES=1`.

## Phase 1 acceptance scenario

The completed slice must demonstrate all of the following in `/Users/brandon/code/personal/cyberdeck` or another explicitly selected trusted repository:

1. Start one Codex session and one Claude session.
2. Attach to each and converse normally.
3. Detach each while it is working and confirm it continues.
4. Reattach to the same session and retain conversation state.
5. Close the tmux pane displaying a session and confirm the provider process remains alive.
6. Start one delegated Codex or Claude worker with a free-form role label.
7. Attach to the delegated worker, steer it, and detach it again.
8. Confirm a Fable delegation is rejected before a provider process starts.
9. Confirm a top-level, explicitly typed Fable start remains possible, but do not invoke it during automated or acceptance tests.

## File map

### Project and documentation

- `.mise.toml` — exact local Node runtime.
- `package.json` — scripts, binary entry point, and dependency manifest.
- `pnpm-lock.yaml` — resolved dependency versions; generated and committed.
- `tsconfig.json` — strict TypeScript build configuration.
- `vitest.config.ts` — test configuration.
- `.gitignore` — build, coverage, and local runtime state exclusions.
- `README.md` — Phase 1 commands, guarantees, limits, and manual demonstration.
- `docs/architecture/session-model.md` — canonical distinction between provider, model, role, execution state, and attachment state.
- `docs/setup/runtime-baseline.md` — dated local runtime evidence and manual capability observations.
- `docs/superpowers/plans/2026-07-20-cyberdeck-setup-phase-1.md` — repository copy of this approved plan.

### Domain and configuration

- `src/domain/session.ts` — session record, lifecycle state, start request, and provider identifiers.
- `src/domain/policy.ts` — concurrency, delegation-depth, and Fable delegation checks only.
- `src/domain/events.ts` — append-only broker and session events.
- `src/config.ts` — validated Phase 1 configuration without provider/model recommendations.
- `src/paths.ts` — short socket path and application-state paths.

### Runtime and providers

- `src/runtime/pty-process.ts` — `node-pty` lifecycle, output buffering, resize, input, and exit events.
- `src/providers/provider.ts` — provider adapter interface.
- `src/providers/codex.ts` — Codex interactive command construction.
- `src/providers/claude.ts` — Claude interactive command construction and update freeze.

### Broker and protocol

- `src/protocol/frames.ts` — Zod schemas for client/server JSONL frames.
- `src/protocol/jsonl.ts` — incremental newline-delimited frame decoder and encoder.
- `src/broker/journal.ts` — append-only event persistence.
- `src/broker/session-registry.ts` — sessions, controller lease, watchers, and parent/child relations.
- `src/broker/server.ts` — Unix-socket server and request routing.
- `src/broker/main.ts` — broker process entry point and signal cleanup.

### CLI and tmux

- `src/client/rpc-client.ts` — request/response and streaming client.
- `src/client/attach.ts` — raw-terminal bridge, replay, resize, and `Ctrl-]` detach.
- `src/client/dashboard.ts` — small textual session dashboard.
- `src/tmux/cockpit.ts` — tmux command construction and cockpit launcher.
- `src/cli.ts` — Commander CLI and all Phase 1 commands.

### Setup and tests

- `scripts/probe-runtimes.ts` — read-only executable/version/auth-status probe; no model calls.
- `tests/fixtures/fake-agent.mjs` — deterministic terminal agent for integration tests.
- `tests/domain/session.test.ts`
- `tests/domain/policy.test.ts`
- `tests/protocol/jsonl.test.ts`
- `tests/runtime/pty-process.test.ts`
- `tests/providers/provider-commands.test.ts`
- `tests/broker/journal.test.ts`
- `tests/broker/session-registry.test.ts`
- `tests/broker/server.test.ts`
- `tests/client/attach.test.ts`
- `tests/tmux/cockpit.test.ts`
- `tests/integration/session-lifecycle.test.ts`

## Pre-execution preservation step

Before Task 1, create `/Users/brandon/code/personal/cyberdeck/docs/superpowers/plans/` and copy this approved deliverable byte-for-byte to `/Users/brandon/code/personal/cyberdeck/docs/superpowers/plans/2026-07-20-cyberdeck-setup-phase-1.md`. This is the execution ledger. During implementation, change only its checkboxes and append concise execution notes; make design changes in the original planning chat or stop for user approval.

## Task 1: Bootstrap the repository and pin the toolchain

**Files:**
- Create: `/Users/brandon/code/personal/cyberdeck/.mise.toml`
- Create: `/Users/brandon/code/personal/cyberdeck/package.json`
- Create: `/Users/brandon/code/personal/cyberdeck/tsconfig.json`
- Create: `/Users/brandon/code/personal/cyberdeck/vitest.config.ts`
- Create: `/Users/brandon/code/personal/cyberdeck/.gitignore`
- Create: `/Users/brandon/code/personal/cyberdeck/src/version.ts`
- Create: `/Users/brandon/code/personal/cyberdeck/tests/version.test.ts`

- [x] **Step 1: Create and initialize the repository**

Run:

```bash
mkdir -p /Users/brandon/code/personal/cyberdeck
git -C /Users/brandon/code/personal/cyberdeck init -b main
```

Expected: an empty Git repository on `main`.

- [x] **Step 2: Pin Node and pnpm**

Create `.mise.toml`:

```toml
[tools]
node = "24.18.0"
```

Create `package.json`:

```json
{
  "name": "cyberdeck",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.5.0",
  "bin": {
    "cyberdeck": "dist/src/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "probe": "tsx scripts/probe-runtimes.ts",
    "dev": "tsx src/cli.ts"
  }
}
```

- [x] **Step 3: Install and lock dependencies**

Run:

```bash
cd /Users/brandon/code/personal/cyberdeck
mise install
mise exec -- corepack enable
mise exec -- pnpm add commander node-pty zod
mise exec -- pnpm add -D @types/node tsx typescript vitest
```

Expected: `pnpm-lock.yaml` exists and `pnpm install --frozen-lockfile` succeeds.

- [x] **Step 4: Add strict compiler and test configuration**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.DS_Store
.cyberdeck/
```

- [x] **Step 5: Write the first failing test**

Create `tests/version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CYBERDECK_VERSION } from "../src/version.js";

describe("CYBERDECK_VERSION", () => {
  it("matches package version for the first release", () => {
    expect(CYBERDECK_VERSION).toBe("0.1.0");
  });
});
```

- [x] **Step 6: Verify the test fails**

Run: `mise exec -- pnpm test -- tests/version.test.ts`

Expected: FAIL because `src/version.ts` does not exist.

- [x] **Step 7: Add the minimal implementation**

Create `src/version.ts`:

```ts
export const CYBERDECK_VERSION = "0.1.0";
```

- [x] **Step 8: Verify the foundation**

Run:

```bash
mise exec -- pnpm test -- tests/version.test.ts
mise exec -- pnpm check
```

Expected: one passing test and no TypeScript errors.

- [x] **Step 9: Commit**

```bash
git add .mise.toml package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore src/version.ts tests/version.test.ts
git commit -m "chore: bootstrap cyberdeck"
```

## Task 2: Record the runtime baseline without spending model usage

**Files:**
- Create: `scripts/probe-runtimes.ts`
- Create: `docs/setup/runtime-baseline.md`
- Test: `tests/setup/probe-runtimes.test.ts`

- [x] **Step 1: Write a failing command-probe test**

Create `tests/setup/probe-runtimes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { probeCommand } from "../../scripts/probe-runtimes.js";

describe("probeCommand", () => {
  it("captures stdout and the executable path without invoking a model", async () => {
    const result = await probeCommand(process.execPath, ["--version"]);
    expect(result.available).toBe(true);
    expect(result.executable).toBe(process.execPath);
    expect(result.output).toMatch(/^v\d+/);
  });

  it("reports a missing executable without throwing", async () => {
    const result = await probeCommand("cyberdeck-command-that-does-not-exist", ["--version"]);
    expect(result.available).toBe(false);
    expect(result.output).toBe("");
  });
});
```

- [x] **Step 2: Run the test and verify failure**

Run: `mise exec -- pnpm test -- tests/setup/probe-runtimes.test.ts`

Expected: FAIL because the probe module does not exist.

- [x] **Step 3: Implement the read-only probe**

Create `scripts/probe-runtimes.ts` with exported `probeCommand()` using `spawn`, collecting stdout and stderr, resolving `{ executable, available, output }`, and never passing prompts. Its executable entry point must probe exactly:

```ts
const probes = [
  ["node", ["--version"]],
  ["pnpm", ["--version"]],
  ["tmux", ["-V"]],
  ["codex", ["--version"]],
  ["claude", ["--version"]],
  ["agent", ["--version"]],
  ["agy", ["--version"]],
] as const;
```

Print one JSON object containing `capturedAt`, platform details, and the results. Do not call a model and do not modify provider configuration.

- [x] **Step 4: Verify the probe**

Run:

```bash
mise exec -- pnpm test -- tests/setup/probe-runtimes.test.ts
mise exec -- pnpm probe
```

Expected: tests pass and JSON reports the installed tools. The July 20 starting evidence is Node `v26.4.0` globally, mise Node `24.18.0`, pnpm `11.5.0`, tmux `3.6a`, Codex CLI `0.144.6`, and Claude Code `2.1.214`; execution must record the then-current values rather than asserting these versions forever.

- [x] **Step 5: Document the baseline and capability checks**

Create `docs/setup/runtime-baseline.md` with:

- the dated probe JSON;
- confirmation that the probe made no model calls;
- the exact commands for `codex login status` and `claude auth status`;
- separate manual rows for interactive start, detach, reattach, steering, cancellation, and native session persistence;
- an explicit statement that no Fable call belongs in setup validation;
- an explicit distinction between an observed capability and a desired Cyberdeck capability.

- [x] **Step 6: Commit**

```bash
git add scripts/probe-runtimes.ts tests/setup/probe-runtimes.test.ts docs/setup/runtime-baseline.md
git commit -m "docs: record runtime capability baseline"
```

## Task 3: Define session data without freezing roles or workflows

**Files:**
- Create: `src/domain/session.ts`
- Create: `src/config.ts`
- Test: `tests/domain/session.test.ts`

- [x] **Step 1: Write failing schema tests**

Create `tests/domain/session.test.ts` asserting:

```ts
import { describe, expect, it } from "vitest";
import { StartSessionRequestSchema } from "../../src/domain/session.js";

describe("StartSessionRequestSchema", () => {
  it("requires an explicit provider and accepts any role label", () => {
    const parsed = StartSessionRequestSchema.parse({
      provider: "claude",
      cwd: "/tmp/repo",
      role: "scout",
      detached: true,
      sandbox: "read-only",
    });
    expect(parsed.provider).toBe("claude");
    expect(parsed.role).toBe("scout");
  });

  it("does not require a model or role", () => {
    const parsed = StartSessionRequestSchema.parse({
      provider: "codex",
      cwd: "/tmp/repo",
      detached: false,
      sandbox: "read-only",
    });
    expect(parsed.model).toBeUndefined();
    expect(parsed.role).toBeUndefined();
  });

  it("rejects a missing provider rather than routing implicitly", () => {
    expect(() => StartSessionRequestSchema.parse({ cwd: "/tmp/repo" })).toThrow();
  });
});
```

- [x] **Step 2: Run and verify failure**

Run: `mise exec -- pnpm test -- tests/domain/session.test.ts`

Expected: FAIL because the schema is absent.

- [x] **Step 3: Implement the session schemas and types**

Create `src/domain/session.ts` with Zod schemas for:

```ts
export const ProviderIdSchema = z.enum(["codex", "claude"]);
export const SandboxSchema = z.enum(["read-only", "workspace-write"]);
export const SessionExecutionStateSchema = z.enum([
  "starting", "active", "exited", "failed", "cancelled",
]);
export const AttachmentStateSchema = z.enum(["detached", "controlled", "watched"]);
```

`StartSessionRequestSchema` must contain explicit `provider`, absolute `cwd`, `detached`, and `sandbox`; optional `model`, `role`, `name`, and `parentSessionId`; and no default provider, model, or role. `SessionRecord` must persist those fields plus UUID `id`, timestamps, execution state, attachment state, PID, exit code, and child IDs. Phase 1 deliberately uses the coarse `active` state rather than parsing provider terminal output to guess whether a model is thinking, using a tool, or idle.

- [x] **Step 4: Add minimal configuration**

Create `src/config.ts` with only:

```ts
export const PhaseOneConfigSchema = z.object({
  maxConcurrentSessions: z.number().int().positive().default(4),
  maxDelegationDepth: z.literal(1).default(1),
  replayBytes: z.number().int().positive().default(128 * 1024),
});
```

Do not add provider preferences, model rankings, role definitions, or workflows.

- [x] **Step 5: Run tests and commit**

```bash
mise exec -- pnpm test -- tests/domain/session.test.ts
mise exec -- pnpm check
git add src/domain/session.ts src/config.ts tests/domain/session.test.ts
git commit -m "feat: define fluid session model"
```

## Task 4: Enforce only Phase 1 safety policy

**Files:**
- Create: `src/domain/policy.ts`
- Test: `tests/domain/policy.test.ts`

- [x] **Step 1: Write failing policy tests**

Create tests proving:

```ts
expect(evaluateStart(topLevelOpus, [])).toEqual({ allowed: true });
expect(evaluateStart(delegatedOpus, [parent])).toEqual({ allowed: true });
expect(evaluateStart(topLevelFable, [])).toEqual({ allowed: true });
expect(evaluateStart(delegatedFable, [parent])).toEqual({
  allowed: false,
  code: "FABLE_REQUIRES_EXPLICIT_HUMAN_START",
});
expect(evaluateStart(grandchild, [parent, child])).toEqual({
  allowed: false,
  code: "MAX_DELEGATION_DEPTH",
});
```

Also test the case-insensitive Fable matcher against `fable`, `claude-fable-5`, and `CLAUDE-FABLE-5`, while confirming `opus`, `sonnet`, and an omitted model do not match.

- [x] **Step 2: Run and verify failure**

Run: `mise exec -- pnpm test -- tests/domain/policy.test.ts`

Expected: FAIL because the policy module is absent.

- [x] **Step 3: Implement minimal policy**

Create `src/domain/policy.ts` with pure functions:

```ts
export function isFableModel(model: string | undefined): boolean {
  return model !== undefined && /(^|-)fable($|-)/i.test(model);
}
```

`evaluateStart()` must enforce only maximum concurrency, maximum parent depth, and the prohibition on delegated Fable. It must not inspect ordinary role labels and must not treat Opus specially.

- [x] **Step 4: Run tests and commit**

```bash
mise exec -- pnpm test -- tests/domain/policy.test.ts
git add src/domain/policy.ts tests/domain/policy.test.ts
git commit -m "feat: gate delegated fable sessions"
```

## Task 5: Implement JSONL framing and append-only events

**Files:**
- Create: `src/domain/events.ts`
- Create: `src/protocol/frames.ts`
- Create: `src/protocol/jsonl.ts`
- Create: `src/broker/journal.ts`
- Create: `src/paths.ts`
- Test: `tests/protocol/jsonl.test.ts`
- Test: `tests/broker/journal.test.ts`

- [x] **Step 1: Write failing fragmented-frame tests**

Test a decoder receiving half a JSON line, then the remainder plus two complete lines. Assert it returns no frame for the first fragment and exactly three validated frames after completion. Test that a malformed line emits a protocol error without crashing the process.

- [x] **Step 2: Implement frames and decoder**

Define client frames for `request`, `input`, `resize`, and `detach`; server frames for `response`, `output`, `event`, and `protocol-error`. Encode PTY bytes as base64. Implement `JsonlDecoder.push(Buffer)` with an internal buffer and newline splitting.

- [x] **Step 3: Write failing journal tests**

Use `mkdtemp()` to create a state directory. Append `session.created` and `session.exited`, then read the file and assert it contains exactly two independently parseable JSON lines in order.

- [x] **Step 4: Implement paths and journal**

`src/paths.ts` must use:

```ts
export const brokerSocketPath = `/tmp/cyberdeck-${process.getuid?.() ?? "user"}.sock`;
export const appStateDirectory = join(homedir(), "Library", "Application Support", "Cyberdeck");
```

`Journal.append()` must create the state directory, append one complete JSON line, and never rewrite existing events.

- [x] **Step 5: Verify and commit**

```bash
mise exec -- pnpm test -- tests/protocol/jsonl.test.ts tests/broker/journal.test.ts
git add src/domain/events.ts src/protocol src/broker/journal.ts src/paths.ts tests/protocol tests/broker/journal.test.ts
git commit -m "feat: add broker protocol and journal"
```

## Task 6: Build provider commands and the PTY runtime

**Files:**
- Create: `src/providers/provider.ts`
- Create: `src/providers/codex.ts`
- Create: `src/providers/claude.ts`
- Create: `src/runtime/pty-process.ts`
- Test: `tests/providers/provider-commands.test.ts`
- Test: `tests/runtime/pty-process.test.ts`
- Create: `tests/fixtures/fake-agent.mjs`

- [x] **Step 1: Write provider-command tests**

Assert the Codex adapter builds:

```text
codex --no-alt-screen -C <cwd> -s <sandbox> -a on-request
```

and adds `-m <model>` only when supplied.

Assert the Claude adapter builds:

```text
claude --session-id <session-uuid> --name <name> --permission-mode <mapped-mode>
```

adds `--model <model>` only when supplied, sets `DISABLE_UPDATES=1`, maps `read-only` to Claude `plan`, and maps `workspace-write` to Claude `manual`. Do not add a Fable or Opus default.

- [x] **Step 2: Implement provider adapters**

Define:

```ts
export interface ProviderLaunchSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ProviderAdapter {
  readonly id: "codex" | "claude";
  buildLaunchSpec(session: SessionRecord): ProviderLaunchSpec;
}
```

Implement both adapters exactly as tested.

- [x] **Step 3: Create the deterministic fake terminal agent**

Create `tests/fixtures/fake-agent.mjs` that prints `READY\r\n`, reads newline-delimited input, echoes `ECHO:<text>\r\n`, emits `WORK:1`, `WORK:2`, and `WORK:DONE` on 50 ms timers for `/work`, and exits cleanly on `/exit`.

- [x] **Step 4: Write PTY runtime tests**

Spawn the fake agent through `node-pty`. Assert output contains `READY`, input produces the echo, `/work` continues while no listener is registered, `snapshot()` includes missed output, resize does not throw, and `/exit` emits one exit event.

- [x] **Step 5: Implement `PtyProcess`**

Wrap `pty.spawn()` and expose:

```ts
write(data: Buffer): void;
resize(cols: number, rows: number): void;
snapshot(): Buffer;
kill(signal?: string): void;
onOutput(listener: (chunk: Buffer) => void): () => void;
onExit(listener: (exitCode: number, signal?: number) => void): () => void;
```

Maintain a byte ring buffer capped at `replayBytes`; remove listeners without stopping the PTY.

- [x] **Step 6: Verify and commit**

```bash
mise exec -- pnpm test -- tests/providers/provider-commands.test.ts tests/runtime/pty-process.test.ts
git add src/providers src/runtime tests/providers tests/runtime tests/fixtures/fake-agent.mjs
git commit -m "feat: run claude and codex in durable ptys"
```

## Task 7: Implement the session registry and attachment lease

**Files:**
- Create: `src/broker/session-registry.ts`
- Test: `tests/broker/session-registry.test.ts`

- [x] **Step 1: Write failing registry tests**

Test all of these independently:

- starting sessions records provider, optional model, optional opaque role, and PID;
- a session can have one controller and two watchers;
- a second controller receives `SESSION_ALREADY_CONTROLLED`;
- disconnecting the controller changes attachment state to detached without calling `kill()`;
- stopping the session calls `kill()` exactly once;
- output is broadcast to controller and watchers;
- delegated children are recorded under their parent;
- a Fable child is rejected before the fake PTY factory is invoked;
- arbitrary roles such as `scout`, `writer`, and `cheap-task` do not affect policy.

- [x] **Step 2: Implement the registry**

Inject provider adapters, PTY factory, journal, and configuration. Implement `start`, `list`, `get`, `attach`, `detach`, `write`, `resize`, `snapshot`, and `stop`. Generate session UUIDs with `crypto.randomUUID()`. Journal creation, attachment, detachment, input metadata without input contents, and exit. `snapshot` returns the current replay buffer and is the Phase 1 source for `cyberdeck logs`; output persistence across broker restarts is explicitly deferred.

- [x] **Step 3: Verify and commit**

```bash
mise exec -- pnpm test -- tests/broker/session-registry.test.ts
git add src/broker/session-registry.ts tests/broker/session-registry.test.ts
git commit -m "feat: manage durable session attachments"
```

## Task 8: Expose the broker through a Unix socket

**Files:**
- Create: `src/broker/server.ts`
- Create: `src/broker/main.ts`
- Test: `tests/broker/server.test.ts`

- [x] **Step 1: Write failing socket tests**

Use a temporary short socket path. Verify request/response correlation for `session.start`, `session.list`, `session.snapshot`, `session.stop`, `session.send`, and `broker.shutdown`; output streaming after `session.attach`; read-only behavior after `session.watch`; controller release when a client socket closes; and `FABLE_REQUIRES_EXPLICIT_HUMAN_START` for delegated Fable.

- [x] **Step 2: Implement server routing**

Use `node:net`. Each connection owns a `JsonlDecoder`. Validate every frame. Route methods to the registry and return structured errors rather than throwing across the socket. Base64-decode input and output. On disconnect, release every attachment owned by that connection without stopping sessions.

- [x] **Step 3: Implement safe broker startup**

On startup, probe the configured socket. Remove it only when no live broker accepts a connection. Install `SIGINT` and `SIGTERM` handlers that close the listener, stop active provider processes, journal broker shutdown, and remove only the exact socket path.

- [x] **Step 4: Verify and commit**

```bash
mise exec -- pnpm test -- tests/broker/server.test.ts
git add src/broker/server.ts src/broker/main.ts tests/broker/server.test.ts
git commit -m "feat: expose session broker over unix socket"
```

## Task 9: Build the CLI and broker lifecycle

**Files:**
- Create: `src/client/rpc-client.ts`
- Create: `src/cli.ts`
- Test: `tests/client/rpc-client.test.ts`
- Test: `tests/cli.test.ts`

- [x] **Step 1: Write failing RPC tests**

Verify concurrent request IDs resolve to the correct responses, output frames remain streaming events, server errors reject with their exact code, and socket closure rejects pending requests.

- [x] **Step 2: Implement `RpcClient`**

Provide `connect`, `request`, `sendFrame`, `onFrame`, and `close`. Use monotonically increasing request IDs and the shared JSONL schemas.

- [x] **Step 3: Write CLI parsing tests**

Assert:

- `start` requires `--provider` and `--cwd`;
- `--role` and `--model` are optional free strings;
- `delegate` requires `--parent`, `--provider`, and `--cwd`;
- no command has a default role, workflow, or model;
- the help text states that top-level Fable is an explicit human action and delegated Fable is refused.

- [x] **Step 4: Implement commands**

Implement:

```text
cyberdeck broker run
cyberdeck broker start
cyberdeck broker status
cyberdeck broker stop
cyberdeck start --provider <claude|codex> --cwd <absolute> [--model] [--role] [--name] [--sandbox] [--attach]
cyberdeck delegate --parent <id> --provider <claude|codex> --cwd <absolute> [--model] [--role] [--name] [--sandbox]
cyberdeck list [--json]
cyberdeck send <id> <message>
cyberdeck stop <id>
cyberdeck logs <id>
```

`broker start` must build first or require existing `dist`, spawn `node dist/src/broker/main.js` detached with logs in the application-state directory, and wait until the socket responds. `broker stop` sends a broker shutdown request; it must not use a broad process kill. `start` defaults its sandbox to `read-only`, defaults to detached presentation, and supports `--attach` to start the attach client immediately. `delegate` always starts detached.

- [x] **Step 5: Verify and commit**

```bash
mise exec -- pnpm test -- tests/client/rpc-client.test.ts tests/cli.test.ts
mise exec -- pnpm build
git add src/client/rpc-client.ts src/cli.ts tests/client/rpc-client.test.ts tests/cli.test.ts
git commit -m "feat: add cyberdeck session commands"
```

## Task 10: Implement attach, watch, detach, replay, and resize

**Files:**
- Create: `src/client/attach.ts`
- Test: `tests/client/attach.test.ts`
- Modify: `src/cli.ts`

- [x] **Step 1: Write terminal-bridge tests**

Inject fake stdin/stdout and RPC transport. Assert:

- control attach forwards stdin as base64 input frames;
- watch mode never forwards input;
- `Ctrl-]` (`0x1d`) sends detach and exits the client without forwarding the byte;
- `SIGWINCH` sends current columns and rows;
- replay output is written before live output;
- cleanup restores the previous raw-mode state;
- socket closure restores the terminal and exits with a non-zero status.

- [x] **Step 2: Implement the bridge**

`attachSession({ mode: "control" | "watch" })` must require a TTY for control mode, set raw mode, register cleanup exactly once, and never kill the provider process during cleanup.

- [x] **Step 3: Add commands**

Add:

```text
cyberdeck attach <id>
cyberdeck watch <id>
```

Print `Detach with Ctrl-]` before entering raw mode. If a session is already controlled, suggest `cyberdeck watch <id>` without stealing control.

- [x] **Step 4: Verify and commit**

```bash
mise exec -- pnpm test -- tests/client/attach.test.ts
mise exec -- pnpm check
git add src/client/attach.ts src/cli.ts tests/client/attach.test.ts
git commit -m "feat: attach to running agent sessions"
```

## Task 11: Add the tmux cockpit as presentation only

**Files:**
- Create: `src/client/dashboard.ts`
- Create: `src/tmux/cockpit.ts`
- Test: `tests/tmux/cockpit.test.ts`
- Modify: `src/cli.ts`

- [x] **Step 1: Write command-construction tests**

Assert the cockpit creates or reuses a session named `cyberdeck`, runs the current Node executable with the absolute built CLI path and `dashboard` in the left pane, opens an ordinary shell in the right pane, and never launches Claude or Codex directly inside tmux.

- [x] **Step 2: Implement dashboard**

Poll `session.list` once per second and render plain text columns for session ID prefix, provider, model or `native-default`, free-form role or `unassigned`, execution state, attachment state, and cwd. Do not display rankings or recommendations.

- [x] **Step 3: Implement cockpit launcher**

Use `spawnSync("tmux", args)` with argument arrays. Resolve the built CLI from `process.argv[1]` and invoke it through `process.execPath`, avoiding a global-install assumption. If the `cyberdeck` tmux session exists, attach to it. Otherwise create the dashboard and shell panes, then attach. Never use tmux pane liveness as broker session liveness.

- [x] **Step 4: Add commands and verify**

Add `cyberdeck dashboard` and `cyberdeck cockpit`.

Run:

```bash
mise exec -- pnpm test -- tests/tmux/cockpit.test.ts
git add src/client/dashboard.ts src/tmux/cockpit.ts src/cli.ts tests/tmux/cockpit.test.ts
git commit -m "feat: add tmux cockpit projection"
```

## Task 12: Prove the complete lifecycle with the fake agent

**Files:**
- Create: `tests/integration/session-lifecycle.test.ts`

- [x] **Step 1: Write the integration test**

Start a real broker on a temporary Unix socket with both provider adapters replaced by the fake-agent adapter. Through real RPC clients:

1. start fake Codex and Claude sessions;
2. attach control to Codex and watch Claude;
3. send `/work` to Codex;
4. disconnect the controlling client after `WORK:1`;
5. wait long enough for `WORK:DONE` while detached;
6. reattach and verify replay contains `WORK:DONE`;
7. create a child with role `luna-high-scout` and confirm the opaque role is preserved;
8. attempt delegated Fable and verify no third PTY is spawned;
9. stop both sessions explicitly.

- [x] **Step 2: Run it repeatedly**

Run:

```bash
mise exec -- pnpm test -- tests/integration/session-lifecycle.test.ts
```

Expected: ten parameterized lifecycle cases pass without leaked sockets or child processes. Implement repetition inside the test with `it.each(Array.from({ length: 10 }, (_, index) => index))` so the command uses only supported Vitest options.

- [x] **Step 3: Run the whole automated suite**

```bash
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
```

Expected: all tests pass, TypeScript has no errors, and `dist/src/cli.js` exists.

- [x] **Step 4: Commit**

```bash
git add tests/integration/session-lifecycle.test.ts
git commit -m "test: verify attach detach lifecycle"
```

## Task 13: Perform the paid-runtime-safe manual acceptance pass

**Files:**
- Modify: `docs/setup/runtime-baseline.md`
- Create: `docs/setup/phase-1-acceptance.md`

- [x] **Step 1: Start the broker and cockpit**

Run:

```bash
mise exec -- pnpm build
node dist/src/cli.js broker start
node dist/src/cli.js cockpit
```

Expected: broker status is healthy and tmux displays the dashboard plus a shell.

- [ ] **Step 2: Start ordinary Codex and Claude sessions only**

Use explicit providers and omit model flags so each native runtime uses its configured ordinary default:

```bash
cyberdeck start --provider codex --cwd /Users/brandon/code/personal/cyberdeck --sandbox read-only --name codex-proof
cyberdeck start --provider claude --cwd /Users/brandon/code/personal/cyberdeck --sandbox read-only --name claude-proof
```

Do not start Fable. Record session IDs.

- [ ] **Step 3: Prove attach and detach for both**

Attach to each, ask it to report its provider/runtime and current directory without modifying files, detach using `Ctrl-]`, wait briefly, and reattach. Record whether the native context and screen remain usable.

- [ ] **Step 4: Prove detached continuation**

Ask each ordinary session for a multi-step read-only repository summary, detach during the response, and reattach after completion. Confirm the completed output is replayed.

- [x] **Step 5: Prove pane independence**

Close the tmux pane showing one agent, run `cyberdeck list` from the remaining shell, and verify the provider PID and session remain alive. Reopen a pane and reattach.

- [x] **Step 6: Prove one delegated worker**

Delegate an explicitly selected ordinary provider with an arbitrary role label such as `luna-high-scout` only if that model/provider is actually available, otherwise use `scout-proof` as a label without attaching semantics to it. Attach, steer, detach, and stop the child.

- [x] **Step 7: Prove the Fable gate without spending Fable usage**

Attempt a delegated start with `--provider claude --model fable`. Expected: `FABLE_REQUIRES_EXPLICIT_HUMAN_START`, and `cyberdeck list` shows no new session. Do not run a top-level Fable session merely to test the allowance.

- [x] **Step 8: Document results honestly**

In `docs/setup/phase-1-acceptance.md`, record exact commands, observable results, session IDs with sensitive portions omitted if necessary, failures, and whether each runtime truly continued or only resumed. Do not upgrade an inferred capability into a verified claim.

- [x] **Step 9: Commit**

```bash
git add docs/setup/runtime-baseline.md docs/setup/phase-1-acceptance.md
git commit -m "docs: verify phase one session mechanics"
```

## Task 14: Document the product boundary and handoff

**Files:**
- Create: `docs/architecture/session-model.md`
- Create: `README.md`
- Create: `docs/superpowers/plans/2026-07-20-cyberdeck-setup-phase-1.md`

- [x] **Step 1: Verify the approved plan copy made before Task 1**

Before Task 1, copy this plan byte-for-byte to `docs/superpowers/plans/2026-07-20-cyberdeck-setup-phase-1.md`. At this step, verify that repository copy exists, then update only execution checkboxes and append execution notes. Do not silently redesign it during execution.

- [x] **Step 2: Write the session-model document**

Document:

- session versus job;
- provider versus model versus free-form role versus attachment state;
- one controller and multiple watchers;
- top-level explicit Fable start versus prohibited Fable delegation;
- Opus having no special restriction;
- why Phase 1 has no workflows or model recommendations;
- the exact boundary between broker process ownership and tmux presentation;
- Phase 1 crash limitation: broker death ends active PTYs.

- [x] **Step 3: Write README commands**

Include installation, build, broker, cockpit, start, attach, watch, detach, send, delegate, stop, logs, test, and probe examples. Every example must specify its provider. Include a prominent warning that `cyberdeck stop` terminates a session while closing a pane merely detaches.

- [x] **Step 4: Run final validation**

```bash
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm test
mise exec -- pnpm check
mise exec -- pnpm build
git status --short
git log --oneline --decorate -15
```

Expected: install, tests, check, and build succeed; the worktree contains only intentional documentation updates if the final documentation commit has not yet been made.

- [x] **Step 5: Commit documentation**

```bash
git add README.md docs/architecture/session-model.md docs/superpowers/plans/2026-07-20-cyberdeck-setup-phase-1.md
git commit -m "docs: define cyberdeck phase one boundary"
```

## Self-review results

- **Spec coverage:** The plan covers the neutral broker, Claude/Codex interactive and detached operation, attach/detach, tmux independence, one bounded delegation, free-form roles, absence of workflows, explicit providers, and the Fable-only premium restriction.
- **Policy correction:** Opus is never treated as Fable, never advisor-only, and never premium-gated. Antigravity, Cursor, Luna model variants, and custom workflows receive no premature semantic mapping.
- **Placeholder scan:** The implementation contains no `TBD`, `TODO`, generic “add tests,” or undefined follow-up work inside Setup and Phase 1. Later-phase features are named only as explicit exclusions.
- **Type consistency:** `provider`, `model`, `role`, `sandbox`, `parentSessionId`, execution state, and attachment state retain the same meanings across schemas, policy, registry, protocol, CLI, and acceptance tests.
- **No-subagent compliance:** All implementation, testing, and self-review are assigned to one inline executing agent.

## Stop condition

Stop after Task 14. Report the acceptance evidence and remaining Phase 1 limitations. Do not begin structured App Server integration, job adapters, Cursor, Antigravity, workflows, automatic routing, worktrees, or Phase 2 planning unless the user explicitly requests it after reviewing the working Phase 1 experience.

## Execution notes

- Executed inline without subagents from 2026-07-20, preserving one commit per plan task.
- The approved plan was copied byte-for-byte before implementation. Task 14 then changed only its execution checkboxes and appended these notes.
- The automated gate passed 15 test files and 60 tests with the deterministic fake terminal agent; check and build also passed.
- Codex completed the live start, attach, detach, continued-execution, replay, pane-independence, steering, delegation, and explicit-stop checks.
- Claude 2.1.214 started and attached, but its native omitted-model default displayed `Fable 5 with high effort`. No prompt was sent and no Fable call was made. The ordinary-Claude start and the two-runtime conversational attach/detach and detached-continuation steps remain unchecked rather than overstated.
- Delegated `--provider claude --model fable` was rejected with `FABLE_REQUIRES_EXPLICIT_HUMAN_START` before a new provider process or session appeared. A top-level Fable start was not run.
- The command runner could not become an attached tmux client because its terminal did not support clear, but tmux created the dashboard and shell panes and their contents were verified through pane metadata and capture.
- Phase 1 stops here. No Phase 2 or Phase 3 feature was implemented.
